# OpenAI Tool Calls Bridge Design

Date: 2026-07-16

## Goal

Make LibreChat MCP tools work through:

```text
LibreChat -> NewAPI -> cursor-api-proxy -> Cursor CLI
```

The proxy currently turns tool schemas into prompt text and always returns
`message.content`. LibreChat requires native OpenAI `message.tool_calls` to
execute MCP tools.

## Scope

- Implement in a small fork of `cursor-api-proxy` 1.1.1.
- Do not change LibreChat or NewAPI.
- Preserve current behavior for requests without tools.
- Support one tool call per model turn. Additional calls use later turns.
- Keep OpenAI request semantics:
  - `stream: true` returns SSE.
  - `stream: false` or omitted returns JSON.
- Tool-enabled turns are buffered to completion before any response body is
  emitted. This trades token-by-token display for reliable protocol shaping.

## Request-to-prompt conversion

For a request with non-empty `tools` and `tool_choice != "none"`:

1. Deduplicate tools by function name.
2. Add a strict instruction that the model may return either a normal answer
   or exactly one tool-call JSON object.
3. Honor:
   - `none`: do not expose tools.
   - `auto` or omitted: normal text or a tool call is allowed.
   - `required` or a named function: instruct the model to call a tool.
4. Serialize prior `assistant.tool_calls` and `role: tool` messages into the
   transcript, including tool name, arguments, call ID, and result, so the
   model can complete the second turn.

Accepted model forms:

```json
{"name":"tool_name","arguments":{"key":"value"}}
```

```json
{"tool_call":{"name":"tool_name","arguments":{"key":"value"}}}
```

Markdown JSON fences and surrounding explanatory text are tolerated. If output
contains duplicates, the first valid call is used.

## Validation and safety

A parsed call is valid only when:

- The name matches a function in the current request's `tools`.
- `arguments` is a JSON object.
- The parsed object is no larger than 64 KiB.

The proxy never executes tools. LibreChat remains the execution boundary.
Invalid or unauthorized objects are returned as ordinary assistant text and
produce a warning containing no tool arguments or token data.

## OpenAI response shaping

Non-streaming tool call:

```json
{
  "message": {
    "role": "assistant",
    "content": null,
    "tool_calls": [{
      "id": "call_<random>",
      "type": "function",
      "function": {
        "name": "tool_name",
        "arguments": "{\"key\":\"value\"}"
      }
    }]
  },
  "finish_reason": "tool_calls"
}
```

For `stream: true`, the proxy buffers Cursor output, then emits:

1. One SSE chunk containing `delta.tool_calls`.
2. One finish chunk with `finish_reason: "tool_calls"` and usage.
3. `data: [DONE]`.

If buffered output is normal text, it is emitted as one content chunk followed
by `finish_reason: "stop"` and `[DONE]`.

## Configuration

Add `CURSOR_BRIDGE_TOOL_CALLS`:

- Default: `false`, preserving upstream behavior.
- Towords deployment: `true`.

## Errors

- Cursor CLI/process failure: preserve existing HTTP/SSE error behavior.
- Invalid tool JSON: return ordinary text; do not synthesize a call.
- Multiple valid calls: use the first only.
- Unknown tool: return ordinary text and a redacted warning.
- Client disconnect while buffering: abort the Cursor child process.

No automatic retry is added; retries would consume quota and could duplicate
side effects.

## Tests

- Parser: raw JSON, wrapper form, fences, surrounding text, duplicates,
  malformed arguments, oversized payload, and unknown names.
- Prompt conversion: deduplicated tools, all `tool_choice` modes, prior
  assistant tool calls, and tool results.
- Non-stream response: native `tool_calls` and `finish_reason`.
- Stream response: buffered SSE tool call, buffered ordinary text, usage, and
  `[DONE]`.
- Regression: requests without tools retain current incremental streaming and
  JSON behavior.
- End-to-end: LibreChat invokes one read-only MCP search exactly once and uses
  its result in the final answer.

## Deployment and rollback

- Build the fork as `1.1.1-towords.1`.
- Deploy under `/opt/cursor-api-proxy/app/current`; do not overwrite the global
  npm package.
- Point systemd at the fork and set `CURSOR_BRIDGE_TOOL_CALLS=true`.
- Keep account directories, bridge key, port, and NewAPI channel unchanged.
- Roll back by disabling the flag or restoring systemd `ExecStart` to
  `/usr/bin/cursor-api-proxy`.
