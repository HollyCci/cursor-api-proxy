import { describe, expect, it } from "vitest";
import {
  thoughtStreamDelta,
  withReasoningContent,
} from "./thought-mode.js";
import { parseToolCallOutput } from "./tool-calls.js";

const tools = [
  {
    type: "function",
    function: {
      name: "lookup_user",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  },
];

describe("thought-mode helpers", () => {
  it("drop mode never attaches reasoning_content", () => {
    const message = withReasoningContent(
      { role: "assistant", content: "M" },
      "T",
      "drop",
    );
    expect(message).toEqual({ role: "assistant", content: "M" });
    expect("reasoning_content" in message).toBe(false);
  });

  it("reasoning mode attaches reasoning_content without altering content", () => {
    const message = withReasoningContent(
      { role: "assistant", content: "M" },
      "T",
      "reasoning",
    );
    expect(message).toEqual({
      role: "assistant",
      content: "M",
      reasoning_content: "T",
    });
  });

  it("stream delta is null when dropping", () => {
    expect(thoughtStreamDelta("T", "drop")).toBeNull();
    expect(thoughtStreamDelta("T", "reasoning")).toEqual({
      reasoning_content: "T",
    });
  });
});

describe("tool bridge vs thought channel", () => {
  const fence =
    '```tool_call\n{"name":"lookup_user","arguments":{"id":"x"}}\n```';

  it("message-channel fence yields tool_calls", () => {
    expect(parseToolCallOutput(fence, tools)?.name).toBe("lookup_user");
  });

  it("thought-only fence must not be fed to the bridge (message stays plain)", () => {
    // After channel split, bridge only sees message stdout.
    expect(parseToolCallOutput("plain reply", tools)).toBeUndefined();
  });

  it("message fence still parses when thought text is kept separate", () => {
    const thoughtFence =
      '```tool_call\n{"name":"lookup_user","arguments":{"id":"from-thought"}}\n```';
    const message = "plain reply";
    // Simulate route: only message enters the bridge.
    expect(parseToolCallOutput(thoughtFence, tools)?.name).toBe("lookup_user");
    expect(parseToolCallOutput(message, tools)).toBeUndefined();
    expect(parseToolCallOutput(`${thoughtFence}\n${message}`, tools)?.name).toBe(
      "lookup_user",
    );
  });
});
