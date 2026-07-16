# OpenAI Tool Calls Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Cursor's textual tool-call JSON into native OpenAI `tool_calls` so LibreChat can execute MCP tools through NewAPI.

**Architecture:** A focused `tool-calls.ts` module owns tool definition normalization, strict prompt generation, balanced JSON extraction, validation, and OpenAI response shaping. `openai.ts` preserves tool-call history in the flattened Cursor prompt, while `chat-completions.ts` buffers only tool-enabled requests and emits either native JSON or standards-compliant SSE after Cursor finishes.

**Tech Stack:** TypeScript, Node.js 18+, Vitest, existing Cursor CLI process adapter, OpenAI Chat Completions JSON/SSE.

## Global Constraints

- Do not change LibreChat or NewAPI.
- Preserve incremental streaming and response shape when `tools` is absent.
- `stream: true` returns SSE; `stream: false` or omitted returns JSON.
- Buffer the full Cursor response whenever the bridge is enabled for a request.
- Support one tool call per model turn; choose the first valid call.
- Tool name must be present in the current request and `arguments` must be a JSON object.
- Reject tool-call candidates larger than 64 KiB.
- The proxy never executes tools and never logs tool arguments.
- No automatic retry.
- `CURSOR_BRIDGE_TOOL_CALLS` defaults to `false`; Towords sets it to `true`.
- Design: `docs/superpowers/specs/2026-07-16-openai-tool-calls-bridge-design.md`

---

## File Structure

```text
src/lib/tool-calls.ts                   # Tool normalization, prompt, parser, response helpers
src/lib/tool-calls.test.ts              # Pure unit tests
src/lib/openai.ts                       # Serialize assistant tool calls and tool results
src/lib/openai.test.ts                  # Prompt-history tests
src/lib/env.ts                          # Read CURSOR_BRIDGE_TOOL_CALLS
src/lib/env.test.ts                     # Env default/override tests
src/lib/config.ts                       # Carry toolCalls in BridgeConfig
src/lib/config.test.ts                  # Config propagation tests
src/lib/handlers/chat-completions.ts    # Buffer and shape tool-enabled responses
src/lib/server.test.ts                  # HTTP JSON/SSE integration tests
README.md                               # Document compatibility and env switch
package.json / package-lock.json        # Fork version 1.1.1-towords.1
```

---

### Task 1: Tool-call domain module

**Files:**
- Create: `src/lib/tool-calls.ts`
- Create: `src/lib/tool-calls.test.ts`

**Interfaces:**
- Produces:
  - `normalizeToolDefinitions(tools: unknown): ToolDefinition[]`
  - `shouldUseToolBridge(tools: unknown, toolChoice: unknown): boolean`
  - `buildToolBridgeSystemText(tools: unknown, toolChoice: unknown): string | undefined`
  - `parseToolCallOutput(text: string, tools: unknown): ParsedToolCall | undefined`
  - `containsToolCallCandidate(text: string): boolean`
  - `resolveAssistantOutput(text: string, tools: unknown, idFactory?: () => string): ResolvedAssistantOutput`
  - `buildBufferedStreamChunks(input: BufferedStreamInput): object[]`

- [ ] **Step 1: Write parser and shaping tests**

Create `src/lib/tool-calls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  parseToolCallOutput,
  resolveAssistantOutput,
  shouldUseToolBridge,
} from "./tool-calls.js";

const tools = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description: "Search messages",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string" } },
        required: ["keyword"],
      },
    },
  },
];

describe("tool bridge activation", () => {
  it("requires tools and respects tool_choice none", () => {
    expect(shouldUseToolBridge(tools, undefined)).toBe(true);
    expect(shouldUseToolBridge(tools, "auto")).toBe(true);
    expect(shouldUseToolBridge(tools, "required")).toBe(true);
    expect(shouldUseToolBridge(tools, "none")).toBe(false);
    expect(shouldUseToolBridge([], undefined)).toBe(false);
  });

  it("deduplicates names and includes strict instructions", () => {
    const text = buildToolBridgeSystemText([...tools, ...tools], "required")!;
    expect(text.match(/Function: search_messages/g)).toHaveLength(1);
    expect(text).toContain("exactly one JSON object");
    expect(text).toContain("must call");
  });
});

describe("parseToolCallOutput", () => {
  it("parses raw and wrapped objects", () => {
    expect(
      parseToolCallOutput(
        '{"name":"search_messages","arguments":{"keyword":"复习"}}',
        tools,
      ),
    ).toEqual({ name: "search_messages", arguments: { keyword: "复习" } });
    expect(
      parseToolCallOutput(
        '{"tool_call":{"name":"search_messages","arguments":{"keyword":"复习"}}}',
        tools,
      ),
    ).toEqual({ name: "search_messages", arguments: { keyword: "复习" } });
  });

  it("accepts fenced/surrounded text and takes the first valid duplicate", () => {
    const text =
      'Calling now.\\n```json\\n{"name":"search_messages","arguments":{"keyword":"first"}}\\n```\\n' +
      '{"name":"search_messages","arguments":{"keyword":"second"}}';
    expect(parseToolCallOutput(text, tools)?.arguments).toEqual({
      keyword: "first",
    });
  });

  it("rejects unknown tools, arrays, malformed JSON, and oversized objects", () => {
    expect(
      parseToolCallOutput('{"name":"delete_all","arguments":{}}', tools),
    ).toBeUndefined();
    expect(
      parseToolCallOutput(
        '{"name":"search_messages","arguments":["复习"]}',
        tools,
      ),
    ).toBeUndefined();
    expect(parseToolCallOutput('{"name":', tools)).toBeUndefined();
    const huge = JSON.stringify({
      name: "search_messages",
      arguments: { keyword: "x".repeat(70 * 1024) },
    });
    expect(parseToolCallOutput(huge, tools)).toBeUndefined();
    expect(
      containsToolCallCandidate('{"name":"delete_all","arguments":{}}'),
    ).toBe(true);
    expect(containsToolCallCandidate("普通回答")).toBe(false);
  });
});

describe("OpenAI shaping", () => {
  it("builds a native tool call", () => {
    const resolved = resolveAssistantOutput(
      '{"name":"search_messages","arguments":{"keyword":"复习"}}',
      tools,
      () => "call_fixed",
    );
    expect(resolved).toEqual({
      kind: "tool_call",
      toolCall: {
        id: "call_fixed",
        type: "function",
        function: {
          name: "search_messages",
          arguments: '{"keyword":"复习"}',
        },
      },
    });
  });

  it("keeps non-tool output as text", () => {
    expect(resolveAssistantOutput("普通回答", tools)).toEqual({
      kind: "text",
      content: "普通回答",
    });
  });

  it("builds buffered SSE payloads with tool_calls finish reason", () => {
    const chunks = buildBufferedStreamChunks({
      id: "chatcmpl_1",
      created: 1,
      model: "composer-2.5",
      text: '{"name":"search_messages","arguments":{"keyword":"复习"}}',
      tools,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      idFactory: () => "call_fixed",
    });
    expect((chunks[0] as any).choices[0].delta.tool_calls[0].id).toBe(
      "call_fixed",
    );
    expect((chunks[1] as any).choices[0].finish_reason).toBe("tool_calls");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- src/lib/tool-calls.test.ts`

Expected: FAIL because `./tool-calls.js` does not exist.

- [ ] **Step 3: Implement the domain module**

Create `src/lib/tool-calls.ts`:

```ts
import { randomUUID } from "node:crypto";

const MAX_TOOL_CALL_BYTES = 64 * 1024;

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ResolvedAssistantOutput =
  | { kind: "tool_call"; toolCall: OpenAiToolCall }
  | { kind: "text"; content: string };

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type BufferedStreamInput = {
  id: string;
  created: number;
  model: string | undefined;
  text: string;
  tools: unknown;
  usage: Usage;
  idFactory?: () => string;
};

export function normalizeToolDefinitions(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  const byName = new Map<string, ToolDefinition>();
  for (const entry of tools) {
    const fn =
      entry && typeof entry === "object" && (entry as any).type === "function"
        ? (entry as any).function
        : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters,
    });
  }
  return [...byName.values()];
}

function isToolChoiceNone(toolChoice: unknown): boolean {
  return toolChoice === "none";
}

export function shouldUseToolBridge(
  tools: unknown,
  toolChoice: unknown,
): boolean {
  return (
    normalizeToolDefinitions(tools).length > 0 &&
    !isToolChoiceNone(toolChoice)
  );
}

function requiredToolName(toolChoice: unknown): string | undefined {
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as any).type === "function" &&
    typeof (toolChoice as any).function?.name === "string"
  ) {
    return (toolChoice as any).function.name;
  }
  return undefined;
}

export function buildToolBridgeSystemText(
  tools: unknown,
  toolChoice: unknown,
): string | undefined {
  const definitions = normalizeToolDefinitions(tools);
  if (definitions.length === 0 || isToolChoiceNone(toolChoice)) return undefined;
  const requiredName = requiredToolName(toolChoice);
  const requirement =
    toolChoice === "required" || requiredName
      ? `You must call ${requiredName ? `the function ${requiredName}` : "one function"}.`
      : "You may answer normally when no function is needed.";
  return [
    "Available tools:",
    ...definitions.map(
      (fn) =>
        `Function: ${fn.name}\\nDescription: ${fn.description ?? ""}\\nParameters: ${JSON.stringify(fn.parameters ?? {})}`,
    ),
    "",
    requirement,
    "To call a tool, output exactly one JSON object and no other text:",
    '{"name":"function_name","arguments":{"key":"value"}}',
    "Never output more than one tool call in this turn.",
  ].join("\\n");
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function containsToolCallCandidate(text: string): boolean {
  return extractJsonObjects(text).some(
    (candidate) =>
      /"name"\s*:/.test(candidate) || /"tool_call"\s*:/.test(candidate),
  );
}

export function parseToolCallOutput(
  text: string,
  tools: unknown,
): ParsedToolCall | undefined {
  const allowed = new Set(normalizeToolDefinitions(tools).map((t) => t.name));
  if (allowed.size === 0) return undefined;
  for (const candidate of extractJsonObjects(text)) {
    if (Buffer.byteLength(candidate, "utf8") > MAX_TOOL_CALL_BYTES) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const value = parsed?.tool_call ?? parsed;
    if (!value || typeof value !== "object") continue;
    if (typeof value.name !== "string" || !allowed.has(value.name)) continue;
    const args = value.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    return { name: value.name, arguments: args };
  }
  return undefined;
}

export function resolveAssistantOutput(
  text: string,
  tools: unknown,
  idFactory: () => string = () =>
    `call_${randomUUID().replaceAll("-", "")}`,
): ResolvedAssistantOutput {
  const parsed = parseToolCallOutput(text, tools);
  if (!parsed) return { kind: "text", content: text };
  return {
    kind: "tool_call",
    toolCall: {
      id: idFactory(),
      type: "function",
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.arguments),
      },
    },
  };
}

export function buildBufferedStreamChunks(
  input: BufferedStreamInput,
): object[] {
  const resolved = resolveAssistantOutput(
    input.text,
    input.tools,
    input.idFactory,
  );
  const base = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
  };
  if (resolved.kind === "tool_call") {
    return [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, ...resolved.toolCall }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: input.usage,
      },
    ];
  }
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: resolved.content },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: input.usage,
    },
  ];
}
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/lib/tool-calls.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tool-calls.ts src/lib/tool-calls.test.ts
git commit -m "feat: parse and shape OpenAI tool calls"
```

---

### Task 2: Tool-aware prompt and history serialization

**Files:**
- Modify: `src/lib/openai.ts:80-109`
- Modify: `src/lib/openai.test.ts:35-182`

**Interfaces:**
- Consumes: OpenAI messages containing `assistant.tool_calls`, `role: tool`,
  `tool_call_id`, and optional `name`.
- Produces: a flattened Cursor transcript that preserves the requested
  function, JSON arguments, call ID, and tool result.

- [ ] **Step 1: Add failing history tests**

Append inside `describe("buildPromptFromMessages", ...)`:

```ts
  it("serialises assistant tool calls even when content is null", () => {
    const prompt = buildPromptFromMessages([
      { role: "user", content: "Search for feedback" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "search_messages",
              arguments: '{"keyword":"复习"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "search_messages",
        content: '{"items":[{"text":"复习太难"}]}',
      },
    ]);
    expect(prompt).toContain(
      'Assistant requested tool search_messages (call_1) with arguments: {"keyword":"复习"}',
    );
    expect(prompt).toContain(
      'Tool result for search_messages (call_1): {"items":[{"text":"复习太难"}]}',
    );
  });

  it("keeps assistant text alongside tool calls", () => {
    const prompt = buildPromptFromMessages([
      {
        role: "assistant",
        content: "I will search.",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "search_messages", arguments: "{}" },
          },
        ],
      },
    ]);
    expect(prompt).toContain("Assistant: I will search.");
    expect(prompt).toContain("Assistant requested tool search_messages");
  });
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- src/lib/openai.test.ts`

Expected: both new tests FAIL because empty-content assistant calls are skipped.

- [ ] **Step 3: Refactor `buildPromptFromMessages`**

Replace the loop in `buildPromptFromMessages` with:

```ts
  for (const m of messages || []) {
    const role = m?.role;
    const text = messageContentToText(m?.content);

    if (role === "assistant" && Array.isArray(m?.tool_calls)) {
      if (text) convo.push(`Assistant: ${text}`);
      for (const call of m.tool_calls) {
        const name = call?.function?.name;
        const args = call?.function?.arguments;
        if (typeof name !== "string") continue;
        const id =
          typeof call?.id === "string" && call.id ? ` (${call.id})` : "";
        convo.push(
          `Assistant requested tool ${name}${id} with arguments: ${
            typeof args === "string" ? args : JSON.stringify(args ?? {})
          }`,
        );
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      if (!text) continue;
      const name =
        typeof m?.name === "string" && m.name ? ` ${m.name}` : "";
      const id =
        typeof m?.tool_call_id === "string" && m.tool_call_id
          ? ` (${m.tool_call_id})`
          : "";
      convo.push(`Tool result for${name}${id}: ${text}`);
      continue;
    }

    if (!text) continue;
    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/lib/openai.test.ts`

Expected: PASS, including existing tool/function message coverage.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai.ts src/lib/openai.test.ts
git commit -m "feat: preserve tool call history in Cursor prompts"
```

---

### Task 3: Opt-in bridge configuration

**Files:**
- Modify: `src/lib/env.ts:18-65,329-392`
- Modify: `src/lib/env.test.ts:9-31`
- Modify: `src/lib/config.ts:22-76,91-133`
- Modify: `src/lib/config.test.ts:6-70`
- Modify: `src/lib/server.test.ts:51-81`

**Interfaces:**
- Produces `LoadedEnv.toolCalls: boolean`.
- Produces `BridgeConfig.toolCalls: boolean`.
- Reads `CURSOR_BRIDGE_TOOL_CALLS`, default `false`.

- [ ] **Step 1: Add failing env/config assertions**

Add to default tests:

```ts
expect(loaded.toolCalls).toBe(false);
```

and:

```ts
expect(config.toolCalls).toBe(false);
```

Add one env test:

```ts
  it("parses CURSOR_BRIDGE_TOOL_CALLS", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_TOOL_CALLS: "true" } }).toolCalls,
    ).toBe(true);
  });
```

Add to the assembled config env and assertions:

```ts
CURSOR_BRIDGE_TOOL_CALLS: "true",
```

```ts
expect(config.toolCalls).toBe(true);
```

- [ ] **Step 2: Verify failures**

Run: `npm test -- src/lib/env.test.ts src/lib/config.test.ts`

Expected: FAIL because `toolCalls` is undefined.

- [ ] **Step 3: Implement config propagation**

Add to `LoadedEnv`:

```ts
/** Convert textual Cursor function requests into OpenAI tool_calls. */
toolCalls: boolean;
```

Add to `loadEnvConfig` return:

```ts
toolCalls: envBool(env, ["CURSOR_BRIDGE_TOOL_CALLS"], false),
```

Add to `BridgeConfig`:

```ts
/** Opt-in OpenAI tool_calls bridge for text-only Cursor output. */
toolCalls: boolean;
```

Add to `loadBridgeConfig` return:

```ts
toolCalls: env.toolCalls,
```

Add `toolCalls: false` to `createTestConfig` in `server.test.ts`.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/lib/env.test.ts src/lib/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/env.ts src/lib/env.test.ts src/lib/config.ts src/lib/config.test.ts src/lib/server.test.ts
git commit -m "feat: add opt-in tool calls bridge setting"
```

---

### Task 4: Buffer and shape JSON/SSE responses

**Files:**
- Modify: `src/lib/handlers/chat-completions.ts:1-307`
- Modify: `src/lib/server.test.ts:1-442`

**Interfaces:**
- Consumes Task 1 helpers and `BridgeConfig.toolCalls`.
- Produces native non-stream `message.tool_calls`.
- Produces buffered SSE `delta.tool_calls` + `finish_reason: tool_calls`.
- Leaves requests without active bridge on the existing paths.

- [ ] **Step 1: Add failing HTTP integration tests**

Import mocked process functions:

```ts
import { run, runStreaming } from "./process.js";
```

Add these tests after the existing non-streaming completion test:

```ts
  it("returns native tool_calls for a bridged non-stream request", async () => {
    vi.mocked(run).mockResolvedValueOnce({
      code: 0,
      stdout:
        '{"name":"search_messages","arguments":{"keyword":"复习"}}',
      stderr: "",
    });
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ toolCalls: true }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", resolve),
    );
    const response = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Search" }],
          tools: [
            {
              type: "function",
              function: {
                name: "search_messages",
                description: "Search",
                parameters: { type: "object" },
              },
            },
          ],
        }),
      },
    );
    const data = JSON.parse(response.body);
    expect(data.choices[0].finish_reason).toBe("tool_calls");
    expect(data.choices[0].message.content).toBeNull();
    expect(data.choices[0].message.tool_calls[0].function.name).toBe(
      "search_messages",
    );
  });

  it("buffers a bridged stream and emits native tool_calls SSE", async () => {
    vi.mocked(runStreaming).mockImplementationOnce(
      async (_cmd, _args, opts) => {
        opts.onLine(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: '{"name":"search_messages","arguments":{"keyword":"复习"}}',
                },
              ],
            },
          }),
        );
        opts.onLine(JSON.stringify({ type: "result", subtype: "success" }));
        return { code: 0, stderr: "" };
      },
    );
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ toolCalls: true }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", resolve),
    );
    const response = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          stream: true,
          messages: [{ role: "user", content: "Search" }],
          tools: [
            {
              type: "function",
              function: {
                name: "search_messages",
                parameters: { type: "object" },
              },
            },
          ],
        }),
      },
    );
    const events = response.body
      .split("\\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events[0].choices[0].delta.tool_calls[0].function.name).toBe(
      "search_messages",
    );
    expect(events[1].choices[0].finish_reason).toBe("tool_calls");
    expect(response.body).toContain("data: [DONE]");
    expect(response.body).not.toContain('delta":{"content"');
  });

  it("keeps incremental streaming when the bridge is inactive", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ toolCalls: true }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", resolve),
    );
    const response = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          stream: true,
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(response.body).toContain('"delta":{"content":"Hello"}');
    expect(response.body).toContain('"finish_reason":"stop"');
  });
```

- [ ] **Step 2: Verify failures**

Run: `npm test -- src/lib/server.test.ts`

Expected: tool-call tests FAIL; existing streaming test behavior remains.

- [ ] **Step 3: Add tool prompt selection and pure response helpers**

In `chat-completions.ts`, import:

```ts
import {
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  parseToolCallOutput,
  resolveAssistantOutput,
  shouldUseToolBridge,
} from "../tool-calls.js";
```

Replace tool prompt selection with:

```ts
  const toolBridgeActive =
    config.toolCalls && shouldUseToolBridge(body.tools, body.tool_choice);
  const toolsText = config.toolCalls
    ? toolBridgeActive
      ? buildToolBridgeSystemText(body.tools, body.tool_choice)
      : undefined
    : toolsToSystemText(body.tools, body.functions);
```

Add local helpers above `handleChatCompletions`:

```ts
function usageFor(prompt: string, completion: string) {
  const prompt_tokens = Math.max(1, Math.round(prompt.length / 4));
  const completion_tokens = Math.max(1, Math.round(completion.length / 4));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

function writeBufferedEvents(
  res: http.ServerResponse,
  chunks: object[],
): void {
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\\n\\n`);
  }
  res.write("data: [DONE]\\n\\n");
}
```

- [ ] **Step 4: Add the buffered streaming branch**

Immediately after SSE headers/error setup and before the ACP/incremental
branches, add:

```ts
    if (toolBridgeActive) {
      let accumulated = "";
      const onLine = config.useAcp
        ? (text: string) => {
            accumulated += text;
          }
        : createStreamParser(
            (text) => {
              accumulated += text;
            },
            () => {},
          );

      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        onLine,
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
      )
        .then(({ code, stderr: stderrOut }) => {
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);
          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60_000);
          }
          if (abortController.signal.aborted) {
            res.end();
            return;
          }
          if (code !== 0) {
            reportRequestError(configDir, latencyMs);
            const publicMsg = logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
            res.write(
              `data: ${JSON.stringify({
                error: { message: publicMsg, code: "cursor_cli_error" },
              })}\\n\\n`,
            );
            res.write("data: [DONE]\\n\\n");
            res.end();
            return;
          }
          reportRequestSuccess(configDir, latencyMs);
          logAccountStats(config.verbose, getAccountStats());
          logTrafficResponse(
            config.verbose,
            model ?? cursorModel,
            accumulated,
            true,
          );
          if (
            containsToolCallCandidate(accumulated) &&
            !parseToolCallOutput(accumulated, body.tools)
          ) {
            console.warn(
              `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
            );
          }
          writeBufferedEvents(
            res,
            buildBufferedStreamChunks({
              id,
              created,
              model: displayModel,
              text: accumulated,
              tools: body.tools,
              usage: usageFor(agentPrompt, accumulated),
            }),
          );
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message:
                    "The Cursor agent stream failed. See server logs for details.",
                  code: "cursor_cli_error",
                },
              })}\\n\\n`,
            );
            res.write("data: [DONE]\\n\\n");
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          res.end();
        });
      return;
    }
```

- [ ] **Step 5: Shape the non-stream response**

Replace the final success response construction with:

```ts
  const usage = usageFor(agentPrompt, content);
  const resolved = toolBridgeActive
    ? resolveAssistantOutput(content, body.tools)
    : { kind: "text" as const, content };
  if (
    toolBridgeActive &&
    resolved.kind === "text" &&
    containsToolCallCandidate(content)
  ) {
    console.warn(
      `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
    );
  }
  const message =
    resolved.kind === "tool_call"
      ? { role: "assistant", content: null, tool_calls: [resolved.toolCall] }
      : { role: "assistant", content: resolved.content };
  const finishReason =
    resolved.kind === "tool_call" ? "tool_calls" : "stop";

  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: displayModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    },
    truncatedHeaders,
  );
```

Leave the existing incremental-path token calculation unchanged; this task
must not alter the no-tools streaming path.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
npm test -- src/lib/server.test.ts
npm run typecheck
npm test
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/handlers/chat-completions.ts src/lib/server.test.ts
git commit -m "feat: emit native tool calls from buffered Cursor output"
```

---

### Task 5: Documentation, release build, deployment, and end-to-end check

**Files:**
- Modify: `README.md:170-200`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Documents `CURSOR_BRIDGE_TOOL_CALLS`.
- Produces build version `1.1.1-towords.1`.
- Deploys without overwriting `/usr/bin/cursor-api-proxy`.

- [ ] **Step 1: Document the bridge**

Add this row to the README environment table:

```md
| `CURSOR_BRIDGE_TOOL_CALLS` | `false` | When enabled, buffers requests containing OpenAI `tools`, converts the first validated Cursor JSON function request into native `tool_calls`, and preserves JSON/SSE semantics from the request's `stream` value. The proxy never executes tools. |
```

Add below the streaming section:

```md
### Tool calls bridge (opt-in)

`CURSOR_BRIDGE_TOOL_CALLS=true` enables compatibility for clients such as
LibreChat that execute OpenAI tools or MCP functions. Tool-enabled turns are
buffered, so they do not display token-by-token; requests without tools keep
incremental streaming. Only tools declared in the current request are accepted,
and the client remains responsible for execution and sending `role: "tool"`
results in the next turn.
```

- [ ] **Step 2: Set the fork version**

Run:

```bash
npm version 1.1.1-towords.1 --no-git-tag-version
```

Expected: `package.json` and `package-lock.json` contain
`1.1.1-towords.1`; no git tag is created.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run build
npm run typecheck
npm test
```

Expected: all commands exit 0.

Commit:

```bash
git add README.md package.json package-lock.json
git commit -m "docs: document opt-in tool calls bridge"
```

- [ ] **Step 4: Deploy the isolated fork**

On the server, preserve the global package and install the release under
`/opt/cursor-api-proxy/app/releases/1.1.1-towords.1`:

```bash
rsync -az --delete \
  --exclude .git --exclude node_modules \
  ./ root@47.245.81.99:/opt/cursor-api-proxy/app/releases/1.1.1-towords.1/

ssh root@47.245.81.99 '
  set -eu
  cd /opt/cursor-api-proxy/app/releases/1.1.1-towords.1
  npm ci
  npm run build
  ln -sfn /opt/cursor-api-proxy/app/releases/1.1.1-towords.1 \
    /opt/cursor-api-proxy/app/current
  grep -q "^CURSOR_BRIDGE_TOOL_CALLS=" \
    /opt/cursor-api-proxy/cursor-api-proxy.env \
    && sed -i "s/^CURSOR_BRIDGE_TOOL_CALLS=.*/CURSOR_BRIDGE_TOOL_CALLS=true/" \
      /opt/cursor-api-proxy/cursor-api-proxy.env \
    || printf "\\nCURSOR_BRIDGE_TOOL_CALLS=true\\n" \
      >> /opt/cursor-api-proxy/cursor-api-proxy.env
  sed -i \
    "s#^ExecStart=.*#ExecStart=/usr/bin/node /opt/cursor-api-proxy/app/current/dist/cli.js#" \
    /etc/systemd/system/cursor-api-proxy.service
  systemctl daemon-reload
  systemctl restart cursor-api-proxy
  systemctl is-active --quiet cursor-api-proxy
'
```

Expected: service is active on the same port 8765.

- [ ] **Step 5: Test native tool calls through NewAPI**

Send a harmless synthetic function:

```bash
curl -sS https://newapi.towords.com/v1/chat/completions \
  -H "Authorization: Bearer $NEWAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"cursor-grok-4.5-medium-fast",
    "stream":false,
    "messages":[{"role":"user","content":"必须调用 probe_tool。"}],
    "tools":[{
      "type":"function",
      "function":{
        "name":"probe_tool",
        "description":"协议测试",
        "parameters":{
          "type":"object",
          "properties":{"query":{"type":"string"}},
          "required":["query"]
        }
      }
    }],
    "tool_choice":"required"
  }' | jq '.choices[0]'
```

Expected:

```json
{
  "message": {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      {
        "type": "function",
        "function": {
          "name": "probe_tool"
        }
      }
    ]
  },
  "finish_reason": "tool_calls"
}
```

- [ ] **Step 6: Test LibreChat MCP end to end**

In LibreChat, select the Cursor custom endpoint and the Plancenter MCP, then
send:

```text
查询今天企微答疑群里与“复习”相关的反馈，只读查询，不要发送消息。
```

Expected:

1. LibreChat displays exactly one MCP invocation.
2. `search_wecom_group_messages_mcp_plancenter` executes once.
3. The final assistant answer summarizes actual tool results.
4. No fenced tool-call JSON appears in the chat.

- [ ] **Step 7: Record rollback command**

If verification fails:

```bash
ssh root@47.245.81.99 '
  set -eu
  sed -i \
    "s#^ExecStart=.*#ExecStart=/usr/bin/cursor-api-proxy#" \
    /etc/systemd/system/cursor-api-proxy.service
  sed -i \
    "s/^CURSOR_BRIDGE_TOOL_CALLS=.*/CURSOR_BRIDGE_TOOL_CALLS=false/" \
    /opt/cursor-api-proxy/cursor-api-proxy.env
  systemctl daemon-reload
  systemctl restart cursor-api-proxy
  systemctl is-active --quiet cursor-api-proxy
'
```

Expected: stock proxy is active and plain chat still works.

---

## Spec Coverage

| Requirement | Task |
|---|---|
| Strict parser, first valid call, 64 KiB limit, whitelist | 1 |
| `tool_choice` semantics and deduplication | 1, 4 |
| Prior assistant call + tool result context | 2 |
| Opt-in, default-off setting | 3 |
| Non-stream native `tool_calls` | 4 |
| Buffered SSE and ordinary text fallback | 4 |
| No-tools regression | 4 |
| Documentation, isolated deployment, rollback | 5 |
| NewAPI and LibreChat end-to-end checks | 5 |

