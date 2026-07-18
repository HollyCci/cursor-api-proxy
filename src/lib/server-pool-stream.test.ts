/**
 * HTTP-level: stream handlers record final pool observation once.
 */
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer } from "./server.js";
import type { BridgeConfig } from "./config.js";
import { runAgentStream, runAgentSync } from "./agent-runner.js";
import {
  getPoolMetricsSnapshot,
  resetPoolMetrics,
} from "./pool-metrics.js";
import { initAccountPool } from "./account-pool.js";

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

const tmpLogPath = "/tmp/cursor-proxy-pool-stream-test-sessions.log";

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
    stickyModel: false,
    cursorFastModel: "composer-2.5",
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
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
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
            headers: res.headers,
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

describe("stream pool observation (HTTP)", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    resetPoolMetrics();
    vi.mocked(runAgentSync).mockReset();
    vi.mocked(runAgentStream).mockReset();
  });

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
    initAccountPool([]);
    resetPoolMetrics();
  });

  it("OpenAI stream records one hit observation on /api/status.pool", async () => {
    vi.mocked(runAgentStream).mockImplementationOnce(
      async (_c, _w, _e, _a, onLine) => {
        onLine("stream-hi");
        return {
          code: 0,
          stderr: "",
          poolHit: true,
          poolObservation: {
            eligible: true,
            hit: true,
            idle: 1,
            warming: 0,
            checkedOut: 0,
            coldSpawn: false,
            accountKey: "/tmp/acc-stream",
            modelKey: "composer-2.5",
          },
        };
      },
    );

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const streamRes = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.body).toContain("stream-hi");

    const status = await fetchServer(servers[0], "/api/status");
    const data = JSON.parse(status.body) as {
      pool: { metrics: { eligible: number; hits: number; coldSpawns: number } };
    };
    expect(data.pool.metrics.eligible).toBe(1);
    expect(data.pool.metrics.hits).toBe(1);
    expect(data.pool.metrics.coldSpawns).toBe(0);
    expect(getPoolMetricsSnapshot().eligible).toBe(1);
  });

  it("Anthropic stream records one miss+cold observation", async () => {
    vi.mocked(runAgentStream).mockImplementationOnce(
      async (_c, _w, _e, _a, onLine) => {
        onLine("anthropic-cold");
        return {
          code: 0,
          stderr: "",
          poolObservation: {
            eligible: true,
            hit: false,
            missReason: "empty",
            idle: 0,
            warming: 0,
            checkedOut: 0,
            coldSpawn: true,
            accountKey: "/tmp/acc-anth",
            modelKey: "composer-2.5",
          },
        };
      },
    );

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const streamRes = await fetchServer(servers[0], "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.body).toContain("anthropic-cold");

    const snap = getPoolMetricsSnapshot();
    expect(snap.eligible).toBe(1);
    expect(snap.hits).toBe(0);
    expect(snap.misses.empty).toBe(1);
    expect(snap.coldSpawns).toBe(1);
  });

  it("plan-upgrade retry records only the final attempt observation", async () => {
    vi.mocked(runAgentStream)
      .mockImplementationOnce(async () => ({
        code: 1,
        stderr: "Upgrade your plan to continue",
        failureText: "Upgrade your plan to continue",
        poolObservation: {
          eligible: true,
          hit: true,
          idle: 0,
          warming: 0,
          checkedOut: 0,
          coldSpawn: false,
          accountKey: "/tmp/acc-a",
          modelKey: "composer-2.5",
        },
      }))
      .mockImplementationOnce(async (_c, _w, _e, _a, onLine) => {
        onLine("from-second");
        return {
          code: 0,
          stderr: "",
          poolHit: true,
          poolObservation: {
            eligible: true,
            hit: true,
            idle: 1,
            warming: 0,
            checkedOut: 0,
            coldSpawn: false,
            accountKey: "/tmp/acc-b",
            modelKey: "composer-2.5",
          },
        };
      });

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/tmp/acc-pool-a", "/tmp/acc-pool-b"],
      }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const streamRes = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.body).toContain("from-second");
    expect(runAgentStream).toHaveBeenCalledTimes(2);

    const snap = getPoolMetricsSnapshot();
    expect(snap.eligible).toBe(1);
    expect(snap.hits).toBe(1);
  });

  it("sync response exposes pool hit headers", async () => {
    vi.mocked(runAgentSync).mockImplementationOnce(async () => ({
      code: 0,
      stdout: "sync-hi",
      stderr: "",
      poolHit: true,
      poolObservation: {
        eligible: true,
        hit: true,
        idle: 1,
        warming: 0,
        checkedOut: 0,
        coldSpawn: false,
        accountKey: "/tmp/acc-sync-hdr",
        modelKey: "composer-2.5",
      },
    }));

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const syncRes = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(syncRes.status).toBe(200);
    expect(syncRes.headers["x-cursor-proxy-pool-hit"]).toBe("1");
    expect(syncRes.headers["x-cursor-proxy-pool-miss-reason"]).toBeUndefined();
    expect(syncRes.body).toContain("sync-hi");
  });

  it("admission denial returns JSON 503 before SSE headers", async () => {
    vi.mocked(runAgentStream).mockImplementationOnce(async () => ({
      code: 1,
      stderr: "cold_spawn_capacity",
      admissionDenied: true,
      retryAfterMs: 2000,
      poolObservation: {
        eligible: true,
        hit: false,
        missReason: "admission_denied",
        idle: 0,
        warming: 0,
        checkedOut: 0,
        coldSpawn: false,
        accountKey: "/tmp/acc-admit",
        modelKey: "composer-2.5",
      },
    }));

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const streamRes = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(streamRes.status).toBe(503);
    expect(streamRes.headers["content-type"]).toMatch(/application\/json/);
    expect(streamRes.headers["retry-after"]).toBe("2");
    expect(streamRes.body).not.toMatch(/^data:/m);
    const err = JSON.parse(streamRes.body) as {
      error: { code: string };
    };
    expect(err.error.code).toBe("cold_spawn_capacity");

    const snap = getPoolMetricsSnapshot();
    expect(snap.eligible).toBe(1);
    expect(snap.misses.admission_denied).toBe(1);
    expect(snap.coldSpawns).toBe(0);
  });
});
