/**
 * HTTP-level acceptance for ACP thought channel policy (Fable).
 * Mocks agent-runner to simulate message/thought split without real ACP.
 */
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer } from "./server.js";
import type { BridgeConfig } from "./config.js";
import { runAgentStream, runAgentSync } from "./agent-runner.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
  ]),
}));

vi.mock("./agent-runner.js", () => ({
  runAgentSync: vi.fn(),
  runAgentStream: vi.fn(),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn(),
  runStreaming: vi.fn(),
}));

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logModelResolution: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

const tmpLogPath = "/tmp/cursor-proxy-thought-test-sessions.log";

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: tmpLogPath,
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    toolCalls: false,
    thoughtMode: "drop",
    sessionPool: false,
    sessionPoolMinIdle: 1,
    sessionPoolMaxSessions: 2,
    sessionPoolIdleTtlMs: 900000,
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  const port = (server.address() as { port: number })?.port;
  const url = `http://127.0.0.1:${port}${path}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) {
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", Buffer.byteLength(options.body));
      req.write(options.body);
    }
    req.end();
  });
}

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

describe("chat completions thought channel (HTTP)", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
    servers = [];
  });

  it("drop mode: content is message-only and omits reasoning_content", async () => {
    vi.mocked(runAgentSync).mockResolvedValueOnce({
      code: 0,
      stdout: "MESSAGE_ONLY",
      stderr: "",
      reasoning: "THOUGHT_SECRET",
    });
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ thoughtMode: "drop" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].message.content).toBe("MESSAGE_ONLY");
    expect(data.choices[0].message.content).not.toContain("THOUGHT_SECRET");
    expect("reasoning_content" in data.choices[0].message).toBe(false);
  });

  it("reasoning mode: attaches reasoning_content; content stays message-only", async () => {
    vi.mocked(runAgentSync).mockResolvedValueOnce({
      code: 0,
      stdout: "MESSAGE_ONLY",
      stderr: "",
      reasoning: "THOUGHT_SECRET",
    });
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ thoughtMode: "reasoning" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].message.content).toBe("MESSAGE_ONLY");
    expect(data.choices[0].message.reasoning_content).toBe("THOUGHT_SECRET");
  });

  it("reasoning stream: thought only in delta.reasoning_content", async () => {
    vi.mocked(runAgentStream).mockImplementationOnce(
      async (_c, _w, _ch, _a, onLine, _t, _p, _d, _s, onThought) => {
        onThought?.("THOUGHT_SECRET");
        onLine("MESSAGE_ONLY");
        return { code: 0, stderr: "" };
      },
    );
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ thoughtMode: "reasoning" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
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
    expect(status).toBe(200);
    const events = parseSseEvents(body);
    const contentParts = events
      .map((e) => (e.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta?.content)
      .filter(Boolean);
    const reasoningParts = events
      .map(
        (e) =>
          (e.choices as Array<{ delta?: { reasoning_content?: string } }>)?.[0]
            ?.delta?.reasoning_content,
      )
      .filter(Boolean);
    expect(contentParts.join("")).toBe("MESSAGE_ONLY");
    expect(contentParts.join("")).not.toContain("THOUGHT_SECRET");
    expect(reasoningParts.join("")).toBe("THOUGHT_SECRET");
  });

  it("drop stream: thought produces no delta", async () => {
    vi.mocked(runAgentStream).mockImplementationOnce(
      async (_c, _w, _ch, _a, onLine, _t, _p, _d, _s, onThought) => {
        onThought?.("THOUGHT_SECRET");
        onLine("MESSAGE_ONLY");
        return { code: 0, stderr: "" };
      },
    );
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ thoughtMode: "drop" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { body } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const events = parseSseEvents(body);
    const reasoningParts = events
      .map(
        (e) =>
          (e.choices as Array<{ delta?: { reasoning_content?: string } }>)?.[0]
            ?.delta?.reasoning_content,
      )
      .filter(Boolean);
    expect(reasoningParts).toEqual([]);
    expect(body).toContain("MESSAGE_ONLY");
    expect(body).not.toContain("THOUGHT_SECRET");
  });

  it("tool bridge: thought-channel tool JSON does not become tool_calls", async () => {
    vi.mocked(runAgentSync).mockResolvedValueOnce({
      code: 0,
      stdout: "plain reply",
      stderr: "",
      reasoning:
        '```tool_call\n{"name":"lookup_user","arguments":{"id":"from-thought"}}\n```',
    });
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ toolCalls: true, thoughtMode: "drop" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup_user",
                description: "Lookup",
                parameters: { type: "object" },
              },
            },
          ],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(data.choices[0].message.content).toBe("plain reply");
    expect(data.choices[0].message.tool_calls).toBeUndefined();
  });

  it("tool bridge: message-channel tool JSON still yields tool_calls", async () => {
    vi.mocked(runAgentSync).mockResolvedValueOnce({
      code: 0,
      stdout:
        '```tool_call\n{"name":"lookup_user","arguments":{"id":"from-message"}}\n```',
      stderr: "",
      reasoning: "THOUGHT_SECRET",
    });
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ toolCalls: true, thoughtMode: "drop" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup_user",
                description: "Lookup",
                parameters: { type: "object" },
              },
            },
          ],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].finish_reason).toBe("tool_calls");
    expect(data.choices[0].message.tool_calls[0].function.name).toBe(
      "lookup_user",
    );
    expect("reasoning_content" in data.choices[0].message).toBe(false);
  });
});
