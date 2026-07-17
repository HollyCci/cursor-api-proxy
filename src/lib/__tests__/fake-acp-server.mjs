/**
 * Minimal fake ACP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, authenticate, session/new, session/prompt.
 *
 * Env:
 * - FAKE_ACP_SCENARIO: unset | empty_models | dup_names | fail_set_config | with_thought | thought_tool_json
 *
 * Emits to stderr for assertions: __FAKE_ACP_SET_CONFIG__:<json>\n
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO || "";
let sessSeq = 0;

function sessionNewResult() {
  sessSeq += 1;
  const sessionId = `sess-${sessSeq}`;
  if (scenario === "empty_models") {
    return { sessionId, models: { availableModels: [] } };
  }
  if (scenario === "dup_names") {
    return {
      sessionId,
      models: {
        availableModels: [
          { modelId: "first-id[]", name: "gpt-4" },
          { modelId: "second-id[]", name: "gpt-4" },
        ],
      },
    };
  }
  return {
    sessionId,
    models: {
      availableModels: [{ modelId: "gpt-4[fast=false]", name: "gpt-4" }],
    },
  };
}

function emitUpdate(sessionId, sessionUpdate, text) {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate,
          content: { text },
        },
      },
    }) + "\n",
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && msg.method) {
      if (msg.method === "session/set_config_option") {
        process.stderr.write(`__FAKE_ACP_SET_CONFIG__:${JSON.stringify(msg.params)}\n`);
      }

      if (msg.method === "session/set_config_option" && scenario === "fail_set_config") {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: "Internal error" },
          }) + "\n",
        );
        return;
      }

      let result = {};
      if (msg.method === "initialize") result = { protocolVersion: 1 };
      else if (msg.method === "authenticate") result = {};
      else if (msg.method === "session/new") result = sessionNewResult();
      else if (msg.method === "session/set_config_option") result = {};
      else if (msg.method === "session/cancel") {
        result = {};
      } else if (msg.method === "session/prompt") {
        result = {};
        const sessionId = msg.params?.sessionId;
        if (scenario === "with_thought") {
          emitUpdate(sessionId, "agent_thought_chunk", "THOUGHT_SECRET");
          emitUpdate(sessionId, "agent_message_chunk", "MESSAGE_ONLY");
        } else if (scenario === "thought_tool_json") {
          emitUpdate(
            sessionId,
            "agent_thought_chunk",
            '```tool_call\n{"name":"lookup_user","arguments":{"id":"from-thought"}}\n```',
          );
          emitUpdate(sessionId, "agent_message_chunk", "plain reply");
        } else {
          emitUpdate(sessionId, "agent_message_chunk", "Hello from fake ACP");
        }
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    }
  } catch {
    /* ignore */
  }
});
