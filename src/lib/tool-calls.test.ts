import { describe, expect, it } from "vitest";
import {
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  normalizeToolDefinitions,
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

const multiTools = [
  ...tools,
  {
    type: "function",
    function: {
      name: "lookup_messages",
      description: "Look up messages",
      parameters: { type: "object" },
    },
  },
];

const searchMessagesChoice = {
  type: "function",
  function: { name: "search_messages" },
};

const usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
};

describe("tool definition normalization", () => {
  it("keeps valid functions, trims names, and deduplicates by name", () => {
    expect(
      normalizeToolDefinitions([
        ...tools,
        ...tools,
        {
          type: "function",
          function: { name: "  lookup  ", description: 42 },
        },
        { type: "custom", function: { name: "ignored" } },
        null,
      ]),
    ).toEqual([
      {
        name: "search_messages",
        description: "Search messages",
        parameters: tools[0]!.function.parameters,
      },
      {
        name: "lookup",
        description: undefined,
        parameters: undefined,
      },
    ]);
    expect(normalizeToolDefinitions({})).toEqual([]);
  });
});

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

  it("honors a named function choice", () => {
    const text = buildToolBridgeSystemText(tools, {
      type: "function",
      function: { name: "search_messages" },
    });
    expect(text).toContain("must call the function search_messages");
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

  it("accepts fenced and surrounded text and takes the first valid duplicate", () => {
    const text =
      'Calling now.\n```json\n{"name":"search_messages","arguments":{"keyword":"first"}}\n```\n' +
      '{"name":"search_messages","arguments":{"keyword":"second"}}';
    expect(parseToolCallOutput(text, tools)?.arguments).toEqual({
      keyword: "first",
    });
  });

  it("extracts balanced nested objects and ignores braces inside strings", () => {
    const candidate = JSON.stringify({
      name: "search_messages",
      arguments: {
        keyword: 'literal } { and "quoted"',
        filters: { nested: true },
      },
    });
    expect(parseToolCallOutput(`Before {not JSON}. ${candidate} After`, tools))
      .toEqual({
        name: "search_messages",
        arguments: {
          keyword: 'literal } { and "quoted"',
          filters: { nested: true },
        },
      });
  });

  it("skips invalid objects before the first valid call", () => {
    const text =
      '{"name":"delete_all","arguments":{}}\n' +
      '{"name":"search_messages","arguments":{"keyword":"valid"}}';
    expect(parseToolCallOutput(text, tools)).toEqual({
      name: "search_messages",
      arguments: { keyword: "valid" },
    });
  });

  it("enforces the tool-name whitelist", () => {
    expect(
      parseToolCallOutput('{"name":"delete_all","arguments":{}}', tools),
    ).toBeUndefined();
  });

  it("enforces a named tool choice within the tool whitelist", () => {
    const lookupCall =
      '{"name":"lookup_messages","arguments":{"keyword":"复习"}}';
    expect(
      parseToolCallOutput(lookupCall, multiTools, {
        toolChoice: searchMessagesChoice,
      }),
    ).toBeUndefined();
    expect(
      parseToolCallOutput(
        '{"name":"search_messages","arguments":{"keyword":"复习"}}',
        multiTools,
        { toolChoice: searchMessagesChoice },
      ),
    ).toEqual({
      name: "search_messages",
      arguments: { keyword: "复习" },
    });
  });

  it("recovers a complete object after an unmatched opening brace", () => {
    const valid =
      '{"name":"search_messages","arguments":{"keyword":"recovered"}}';
    expect(
      parseToolCallOutput(`Ignored prefix { never closed\n${valid}`, tools),
    ).toEqual({
      name: "search_messages",
      arguments: { keyword: "recovered" },
    });
  });

  it("recovers after an unterminated JSON string with a raw newline", () => {
    const text =
      '{"broken\n' +
      '{"name":"search_messages","arguments":{"keyword":"ok"}}';
    expect(parseToolCallOutput(text, tools)).toEqual({
      name: "search_messages",
      arguments: { keyword: "ok" },
    });
  });

  it("finds a valid call after at least 65 unrelated complete objects", () => {
    const unrelated = Array.from({ length: 65 }, (_, index) =>
      JSON.stringify({ irrelevant: index }),
    ).join("\n");
    const valid =
      '{"name":"search_messages","arguments":{"keyword":"after-65"}}';
    expect(parseToolCallOutput(`${unrelated}\n${valid}`, tools)).toEqual({
      name: "search_messages",
      arguments: { keyword: "after-65" },
    });
  });

  it("rejects deeply nested arguments without throwing", () => {
    const depth = 10_000;
    const nestedArrays = `${"[".repeat(depth)}null${"]".repeat(depth)}`;
    const text =
      `{"name":"search_messages","arguments":{"value":${nestedArrays}}}`;
    let result: ReturnType<typeof parseToolCallOutput>;
    expect(() => {
      result = parseToolCallOutput(text, tools);
    }).not.toThrow();
    expect(result! === undefined).toBe(true);
  });

  it("requires arguments to be a non-array object", () => {
    for (const argumentsValue of [null, ["复习"], "复习", 1, true]) {
      expect(
        parseToolCallOutput(
          JSON.stringify({
            name: "search_messages",
            arguments: argumentsValue,
          }),
          tools,
        ),
      ).toBeUndefined();
    }
    expect(
      parseToolCallOutput(
        '{"name":"search_messages","arguments":{}}',
        tools,
      ),
    ).toEqual({ name: "search_messages", arguments: {} });
  });

  it("rejects malformed JSON and candidates larger than 64 KiB", () => {
    expect(parseToolCallOutput('{"name":', tools)).toBeUndefined();
    const underLimit = JSON.stringify({
      name: "search_messages",
      arguments: { keyword: "x".repeat(63 * 1024) },
    });
    expect(parseToolCallOutput(underLimit, tools)?.name).toBe(
      "search_messages",
    );
    const oversized = JSON.stringify({
      name: "search_messages",
      arguments: { keyword: "x".repeat(64 * 1024) },
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(64 * 1024);
    expect(parseToolCallOutput(oversized, tools)).toBeUndefined();
  });

  it("detects tool-shaped candidates without validating them", () => {
    expect(
      containsToolCallCandidate('{"name":"delete_all","arguments":{}}'),
    ).toBe(true);
    expect(
      containsToolCallCandidate(
        '{"tool_call":{"name":"delete_all","arguments":{}}}',
      ),
    ).toBe(true);
    expect(containsToolCallCandidate('{"name":')).toBe(true);
    expect(
      containsToolCallCandidate('{"meta":1,"name":"search_messages"'),
    ).toBe(true);
    expect(containsToolCallCandidate("普通回答")).toBe(false);
  });
});

describe("OpenAI shaping", () => {
  it("builds a native tool call", () => {
    const resolved = resolveAssistantOutput(
      '{"name":"search_messages","arguments":{"keyword":"复习"}}',
      tools,
      { idFactory: () => "call_fixed" },
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

  it("keeps a non-selected whitelisted tool call as text", () => {
    const text = '{"name":"lookup_messages","arguments":{"keyword":"复习"}}';
    expect(
      resolveAssistantOutput(text, multiTools, {
        toolChoice: searchMessagesChoice,
        idFactory: () => "call_fixed",
      }),
    ).toEqual({ kind: "text", content: text });
  });

  it("keeps ordinary and no-tools output as text", () => {
    expect(resolveAssistantOutput("普通回答", tools)).toEqual({
      kind: "text",
      content: "普通回答",
    });
    const unexposedCall =
      '{"name":"search_messages","arguments":{"keyword":"复习"}}';
    expect(resolveAssistantOutput(unexposedCall, [])).toEqual({
      kind: "text",
      content: unexposedCall,
    });
  });

  it("builds buffered SSE-shaped tool-call chunks", () => {
    const chunks = buildBufferedStreamChunks({
      id: "chatcmpl_1",
      created: 1,
      model: "composer-2.5",
      text: '{"name":"search_messages","arguments":{"keyword":"复习"}}',
      tools,
      usage,
      options: { idFactory: () => "call_fixed" },
    });
    expect(chunks).toEqual([
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "composer-2.5",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_fixed",
                  type: "function",
                  function: {
                    name: "search_messages",
                    arguments: '{"keyword":"复习"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "composer-2.5",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage,
      },
    ]);
  });

  it("propagates named tool choice through buffered stream options", () => {
    const text = '{"name":"lookup_messages","arguments":{"keyword":"复习"}}';
    const chunks = buildBufferedStreamChunks({
      id: "chatcmpl_3",
      created: 3,
      model: "composer-2.5",
      text,
      tools: multiTools,
      usage,
      options: {
        toolChoice: searchMessagesChoice,
        idFactory: () => "call_fixed",
      },
    }) as Array<{ choices: Array<{ delta: unknown; finish_reason: unknown }> }>;
    expect(chunks[0]!.choices[0]!.delta).toEqual({
      role: "assistant",
      content: text,
    });
    expect(chunks[1]!.choices[0]!.finish_reason).toBe("stop");
  });

  it("builds buffered SSE-shaped text chunks when no tool is selected", () => {
    const chunks = buildBufferedStreamChunks({
      id: "chatcmpl_2",
      created: 2,
      model: undefined,
      text: "普通回答",
      tools,
      usage,
    });
    expect(chunks).toEqual([
      {
        id: "chatcmpl_2",
        object: "chat.completion.chunk",
        created: 2,
        model: undefined,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "普通回答" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl_2",
        object: "chat.completion.chunk",
        created: 2,
        model: undefined,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      },
    ]);
  });
});
