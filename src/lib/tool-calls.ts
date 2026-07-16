import { randomUUID } from "node:crypto";

const MAX_TOOL_CALL_BYTES = 64 * 1024;
const MAX_ARGUMENT_CONTAINER_DEPTH = 64;
const MAX_ARGUMENT_NODES = 32 * 1024;

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

export type ToolCallParseOptions = {
  toolChoice?: unknown;
};

export type ResolveAssistantOutputOptions = ToolCallParseOptions & {
  idFactory?: () => string;
};

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
  options?: ResolveAssistantOutputOptions;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolDefinitions(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];

  const byName = new Map<string, ToolDefinition>();
  for (const entry of tools) {
    if (!isRecord(entry) || entry.type !== "function") continue;
    const fn = entry.function;
    if (!isRecord(fn)) continue;

    const name = typeof fn.name === "string" ? fn.name.trim() : "";
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
  if (!isRecord(toolChoice) || toolChoice.type !== "function") {
    return undefined;
  }
  const fn = toolChoice.function;
  if (!isRecord(fn) || typeof fn.name !== "string") return undefined;
  return fn.name;
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
        `Function: ${fn.name}\nDescription: ${fn.description ?? ""}\nParameters: ${JSON.stringify(fn.parameters ?? {})}`,
    ),
    "",
    requirement,
    "To call a tool, output exactly one JSON object and no other text:",
    '{"name":"function_name","arguments":{"key":"value"}}',
    "Never output more than one tool call in this turn.",
  ].join("\n");
}

type JsonObjectNode = {
  start: number;
  end?: number;
  children: JsonObjectNode[];
};

function collectJsonObjects(
  text: string,
  nodes: JsonObjectNode[],
  objects: string[],
): void {
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.end === undefined) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        pending.push(node.children[i]!);
      }
      continue;
    }

    const characterLength = node.end - node.start + 1;
    if (characterLength > MAX_TOOL_CALL_BYTES) continue;
    const candidate = text.slice(node.start, node.end + 1);
    if (Buffer.byteLength(candidate, "utf8") <= MAX_TOOL_CALL_BYTES) {
      objects.push(candidate);
    }
  }
}

function extractJsonObjects(text: string): string[] {
  const roots: JsonObjectNode[] = [];
  const stack: JsonObjectNode[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (stack.length === 0 && char !== "{") {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char <= "\u001f") {
        stack.length = 0;
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      const node: JsonObjectNode = { start: i, children: [] };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    } else if (char === "}") {
      const node = stack.pop();
      if (node) node.end = i;
    }
  }

  const objects: string[] = [];
  collectJsonObjects(text, roots, objects);
  return objects;
}

export function containsToolCallCandidate(text: string): boolean {
  return /"(?:name|tool_call)"\s*:/.test(text);
}

function hasSafeArgumentsShape(
  argumentsValue: Record<string, unknown>,
): boolean {
  const pending: Array<{ value: unknown; containerDepth: number }> = [
    { value: argumentsValue, containerDepth: 1 },
  ];
  let visitedNodes = 0;

  while (pending.length > 0) {
    const { value, containerDepth } = pending.pop()!;
    visitedNodes += 1;
    if (visitedNodes > MAX_ARGUMENT_NODES) return false;
    if (value === null || typeof value !== "object") continue;
    if (containerDepth > MAX_ARGUMENT_CONTAINER_DEPTH) return false;

    const children = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (const child of children) {
      const childIsContainer = child !== null && typeof child === "object";
      pending.push({
        value: child,
        containerDepth: containerDepth + (childIsContainer ? 1 : 0),
      });
    }
  }
  return true;
}

export function parseToolCallOutput(
  text: string,
  tools: unknown,
  options: ToolCallParseOptions = {},
): ParsedToolCall | undefined {
  const allowed = new Set(
    normalizeToolDefinitions(tools).map((tool) => tool.name),
  );
  if (allowed.size === 0) return undefined;
  const selectedName = requiredToolName(options.toolChoice);

  for (const candidate of extractJsonObjects(text)) {
    if (Buffer.byteLength(candidate, "utf8") > MAX_TOOL_CALL_BYTES) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!isRecord(parsed)) continue;
    const value = isRecord(parsed.tool_call) ? parsed.tool_call : parsed;
    if (typeof value.name !== "string" || !allowed.has(value.name)) continue;
    if (selectedName !== undefined && value.name !== selectedName) continue;
    if (!isRecord(value.arguments)) continue;
    if (!hasSafeArgumentsShape(value.arguments)) continue;

    return { name: value.name, arguments: value.arguments };
  }
  return undefined;
}

export function resolveAssistantOutput(
  text: string,
  tools: unknown,
  options: ResolveAssistantOutputOptions = {},
): ResolvedAssistantOutput {
  const parsed = parseToolCallOutput(text, tools, {
    toolChoice: options.toolChoice,
  });
  if (!parsed) return { kind: "text", content: text };

  const idFactory =
    options.idFactory ??
    (() => `call_${randomUUID().replaceAll("-", "")}`);
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
    input.options,
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
