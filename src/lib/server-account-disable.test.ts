/**
 * HTTP-level acceptance for account plan-disable (503 no_usable_accounts).
 */
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer } from "./server.js";
import type { BridgeConfig } from "./config.js";
import { runAgentStream, runAgentSync } from "./agent-runner.js";
import {
  initAccountPool,
  getUsableCount,
  getNextAccountConfigDir,
  getAccountStats,
} from "./account-pool.js";
import { quarantineAccount } from "./account-quarantine.js";

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

const tmpLogPath = "/tmp/cursor-proxy-account-disable-test-sessions.log";

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
): Promise<{ status: number; body: string; contentType?: string }> {
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
            contentType: res.headers["content-type"],
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

describe("account plan-disable (HTTP)", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
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
  });

  it("returns 503 JSON no_usable_accounts when all accounts quarantined (sync)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/tmp/acc-disable-a", "/tmp/acc-disable-b"],
      }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    quarantineAccount("/tmp/acc-disable-a", "upgrade_plan");
    quarantineAccount("/tmp/acc-disable-b", "upgrade_plan");
    expect(getUsableCount()).toBe(0);

    const { status, body, contentType } = await fetchServer(
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

    expect(status).toBe(503);
    expect(contentType).toMatch(/json/i);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("no_usable_accounts");
    expect(data.error.message).toMatch(/No usable Cursor accounts/i);
    expect(runAgentSync).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 503 JSON no_usable_accounts before SSE when stream requested", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/tmp/acc-disable-a", "/tmp/acc-disable-b"],
      }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    quarantineAccount("/tmp/acc-disable-a", "upgrade_plan");
    quarantineAccount("/tmp/acc-disable-b", "upgrade_plan");

    const { status, body, contentType } = await fetchServer(
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

    expect(status).toBe(503);
    expect(contentType).toMatch(/json/i);
    expect(contentType).not.toMatch(/text\/event-stream/i);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("no_usable_accounts");
    expect(runAgentStream).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("sync failover: plan-upgrade on first account retries once on second", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/tmp/acc-disable-a", "/tmp/acc-disable-b"],
      }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    vi.mocked(runAgentSync)
      .mockResolvedValueOnce({
        code: 0,
        stdout: "Upgrade your plan to continue",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "ok from b",
        stderr: "",
      });

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
    expect(runAgentSync).toHaveBeenCalledTimes(2);
    const data = JSON.parse(body);
    expect(data.choices?.[0]?.message?.content).toMatch(/ok from b/);
    expect(
      getAccountStats().find((s) => s.configDir === "/tmp/acc-disable-a")
        ?.isDisabled,
    ).toBe(true);
    expect(getUsableCount()).toBe(1);
    expect(getNextAccountConfigDir()).toBe("/tmp/acc-disable-b");
    spy.mockRestore();
  });

  it("sync does not quarantine long success that mentions upgrade", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/tmp/acc-disable-a", "/tmp/acc-disable-b"],
      }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const long = `${"x".repeat(200)} Upgrade your plan to continue ${"y".repeat(200)}`;
    vi.mocked(runAgentSync).mockResolvedValue({
      code: 0,
      stdout: long,
      stderr: "",
      failureText: long,
    });

    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(status).toBe(200);
    expect(getUsableCount()).toBe(2);
    spy.mockRestore();
  });
});
