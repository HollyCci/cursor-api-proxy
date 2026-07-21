import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AcpConnection } from "./acp-connection.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import {
  agentResultFromPoolPromptError,
  runAgentStream,
  runAgentSync,
} from "./agent-runner.js";
import {
  initSessionPool,
  poolAccountKey,
  shutdownSessionPool,
  type VirginSessionPool,
} from "./acp-session-pool.js";
import type { BridgeConfig } from "./config.js";
import {
  configureAdmission,
  resetAdmissionForTests,
} from "./admission.js";
import {
  getPoolMetricsSnapshot,
  recordFinalPoolObservation,
  resetPoolMetrics,
} from "./pool-metrics.js";

vi.mock("./acp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./acp-client.js")>();
  return {
    ...actual,
    runAcpSync: vi.fn(),
    runAcpStream: vi.fn(),
  };
});

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: node,
    acpArgs: [fakeServerPath],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "composer-2.5",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    stickyModel: false,
    cursorFastModel: "composer-2.5",
    workspace: cwd,
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/cursor-proxy-agent-runner-test.log",
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
    sessionPool: true,
    sessionPoolMinIdle: 1,
    sessionPoolMaxSessions: 2,
    sessionPoolIdleTtlMs: 60_000,
    // Deterministic miss→cold path: do not wait for async refill.
    poolWaitMs: 0,
    maxColdSpawns: 4,
    maxColdSpawnsPerAccount: 2,
    ...overrides,
  };
}

async function waitPooled(pool: VirginSessionPool, account: string, n = 1) {
  for (let i = 0; i < 80; i++) {
    if ((pool.stats()[account]?.pooled ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for pooled=${n} account=${account}`);
}

describe("agentResultFromPoolPromptError", () => {
  it("returns failed AgentRunResult for plan-upgrade error channel text", () => {
    const err = new Error("Upgrade your plan to continue");
    expect(agentResultFromPoolPromptError(err)).toEqual({
      code: 1,
      stdout: "",
      stderr: "Upgrade your plan to continue",
      failureText: "Upgrade your plan to continue",
      poolHit: true,
    });
  });

  it("returns null for ordinary errors so cold fallback can proceed", () => {
    expect(
      agentResultFromPoolPromptError(new Error("connection reset")),
    ).toBeNull();
  });
});

describe("runAgentSync pool observation", () => {
  beforeEach(() => {
    resetPoolMetrics();
    resetAdmissionForTests();
    configureAdmission({
      maxColdSpawns: 4,
      maxColdSpawnsPerAccount: 2,
      poolWaitMs: 0,
    });
    vi.mocked(runAcpSync).mockReset();
    vi.mocked(runAcpStream).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    shutdownSessionPool();
    resetAdmissionForTests();
    vi.restoreAllMocks();
  });

  it("attaches hit observation when virgin pool serves the request", async () => {
    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    expect(pool).not.toBeNull();
    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-hit");
    await pool!.ensureWarm(account, "composer-2.5");
    await waitPooled(pool!, account);

    const out = await runAgentSync(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      account,
    );

    expect(out.poolHit).toBe(true);
    expect(out.code).toBe(0);
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: true,
      coldSpawn: false,
      accountKey: account,
      modelKey: "composer-2.5",
    });
    expect(runAcpSync).not.toHaveBeenCalled();

    recordFinalPoolObservation(out.poolObservation);
    const snap = getPoolMetricsSnapshot();
    expect(snap.eligible).toBe(1);
    expect(snap.hits).toBe(1);
    expect(snap.coldSpawns).toBe(0);
  });

  it("attaches miss + coldSpawn when pool has no idle session", async () => {
    initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    vi.mocked(runAcpSync).mockResolvedValue({
      code: 0,
      stdout: "cold reply",
      stderr: "",
      latencyMarks: {},
    });

    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-empty");
    const out = await runAgentSync(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      account,
    );

    expect(out.poolHit).toBeFalsy();
    expect(out.stdout).toBe("cold reply");
    // Hot-path ensureWarm often registers a warming slot before checkout → "warming";
    // otherwise "empty". Either is a correct no-idle miss.
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: false,
      coldSpawn: true,
      accountKey: account,
      modelKey: "composer-2.5",
    });
    expect(["empty", "warming"]).toContain(out.poolObservation?.missReason);
    expect(runAcpSync).toHaveBeenCalledTimes(1);

    recordFinalPoolObservation(out.poolObservation);
    const snap = getPoolMetricsSnapshot();
    expect(snap.eligible).toBe(1);
    expect(snap.hits).toBe(0);
    expect(snap.coldSpawns).toBe(1);
    expect(
      (snap.misses.empty ?? 0) + (snap.misses.warming ?? 0),
    ).toBe(1);
  });

  it("passes BridgeConfig.timeoutMs as ACP requestTimeoutMs on cold path", async () => {
    initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    vi.mocked(runAcpSync).mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      latencyMarks: {},
    });
    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-timeout");
    await runAgentSync(
      baseConfig({ timeoutMs: 300_000 }),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      account,
    );
    expect(runAcpSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requestTimeoutMs: 300_000 }),
    );
  });

  it("passes BridgeConfig.timeoutMs as ACP requestTimeoutMs on cold stream path", async () => {
    initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    vi.mocked(runAcpStream).mockResolvedValue({
      code: 0,
      stderr: "",
    });
    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-timeout-stream");
    await runAgentStream(
      baseConfig({ timeoutMs: 300_000 }),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      () => undefined,
      undefined,
      "hi",
      account,
    );
    expect(runAcpStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requestTimeoutMs: 300_000 }),
      expect.anything(),
      undefined,
    );
  });

  it("attaches warming miss when only warming slots exist", async () => {
    const createGate = {
      promise: Promise.resolve(),
      resolve: () => undefined as void,
    };
    let release!: () => void;
    createGate.promise = new Promise<void>((r) => {
      release = r;
    });

    const fakeConn = {
      id: "fake-warm",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        await createGate.promise;
        return {
          sessionId: "sess-warm",
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "x", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-warming");
    void pool!.ensureWarm(account, "composer-2.5");
    for (let i = 0; i < 80; i++) {
      if ((pool!.stats()[account]?.warming ?? 0) >= 1) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    vi.mocked(runAcpSync).mockResolvedValue({
      code: 0,
      stdout: "cold while warming",
      stderr: "",
      latencyMarks: {},
    });

    const out = await runAgentSync(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      account,
    );

    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: false,
      missReason: "warming",
      coldSpawn: true,
    });
    release();
  });

  it("marks prompt_failed (not hit) when checkout succeeds but stdout is empty", async () => {
    const fakeConn = {
      id: "fake-empty",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => ({
        sessionId: "sess-empty",
        createdAt: Date.now(),
        sessionCwd: undefined,
        effectiveModel: "composer-2.5",
      }),
      promptOnce: async () => ({ stdout: "   ", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    const account = poolAccountKey("/tmp/cursor-proxy-pool-obs/acc-empty-out");
    await pool!.ensureWarm(account, "composer-2.5");
    await waitPooled(pool!, account);

    vi.mocked(runAcpSync).mockResolvedValue({
      code: 0,
      stdout: "cold after empty",
      stderr: "",
      latencyMarks: {},
    });

    const out = await runAgentSync(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      account,
    );

    expect(out.poolHit).toBeFalsy();
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: false,
      missReason: "prompt_failed",
      coldSpawn: true,
    });
  });

  it("does not attach observation for ineligible traffic (max mode)", async () => {
    initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    vi.mocked(runAcpSync).mockResolvedValue({
      code: 0,
      stdout: "max path",
      stderr: "",
      latencyMarks: {},
    });

    const out = await runAgentSync(
      baseConfig({ maxMode: true }),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      undefined,
      "hi",
      "acc-max",
    );

    expect(out.poolObservation).toBeUndefined();
    recordFinalPoolObservation(out.poolObservation);
    expect(getPoolMetricsSnapshot().eligible).toBe(0);
  });

  it("recordFinalPoolObservation counts only the final attempt observation", () => {
    const first = {
      eligible: true,
      hit: false,
      missReason: "empty" as const,
      idle: 0,
      warming: 0,
      checkedOut: 0,
      coldSpawn: true,
      accountKey: "a",
      modelKey: "composer-2.5",
    };
    const second = {
      eligible: true,
      hit: true,
      idle: 1,
      warming: 0,
      checkedOut: 0,
      coldSpawn: false,
      accountKey: "b",
      modelKey: "composer-2.5",
    };
    // Simulate handler retry: only record final out
    recordFinalPoolObservation(second);
    expect(getPoolMetricsSnapshot()).toEqual({
      eligible: 1,
      hits: 1,
      misses: {},
      coldSpawns: 0,
    });
    void first;
  });
});

describe("runAgentStream virgin pool", () => {
  beforeEach(() => {
    resetPoolMetrics();
    resetAdmissionForTests();
    configureAdmission({
      maxColdSpawns: 4,
      maxColdSpawnsPerAccount: 2,
      poolWaitMs: 0,
    });
    vi.mocked(runAcpSync).mockReset();
    vi.mocked(runAcpStream).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    shutdownSessionPool();
    resetAdmissionForTests();
    vi.restoreAllMocks();
  });

  it("does not cold-fallback after a streamed chunk then prompt error", async () => {
    const account = poolAccountKey("/tmp/cursor-proxy-pool-stream/acc-commit");
    const fakeConn = {
      id: "stream-commit",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => ({
        sessionId: "sess-commit",
        createdAt: Date.now(),
        sessionCwd: undefined,
        effectiveModel: "composer-2.5",
      }),
      promptOnce: async (
        _sessionId: string,
        _prompt: string,
        opts?: { onChunk?: (t: string) => void },
      ) => {
        opts?.onChunk?.("partial");
        throw new Error("stream broke after chunk");
      },
    } as unknown as AcpConnection;

    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await pool!.ensureWarm(account, "composer-2.5");
    await waitPooled(pool!, account);

    const chunks: string[] = [];
    const out = await runAgentStream(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      (t) => chunks.push(t),
      undefined,
      "hi",
      account,
    );

    expect(chunks).toEqual(["partial"]);
    expect(runAcpStream).not.toHaveBeenCalled();
    expect(out.code).not.toBe(0);
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: false,
      missReason: "prompt_failed",
      coldSpawn: false,
    });
  });

  it("serves stream hit from pool without calling runAcpStream", async () => {
    const account = poolAccountKey("/tmp/cursor-proxy-pool-stream/acc-hit");
    const fakeConn = {
      id: "stream-hit",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => ({
        sessionId: "sess-hit",
        createdAt: Date.now(),
        sessionCwd: undefined,
        effectiveModel: "composer-2.5",
      }),
      promptOnce: async (
        _sessionId: string,
        _prompt: string,
        opts?: {
          onChunk?: (t: string) => void;
          onThoughtChunk?: (t: string) => void;
        },
      ) => {
        opts?.onThoughtChunk?.("think");
        opts?.onChunk?.("hello");
        return {
          stdout: "hello",
          reasoning: "think",
          latencyMarks: { prompt_dispatched: 1 },
        };
      },
    } as unknown as AcpConnection;

    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await pool!.ensureWarm(account, "composer-2.5");
    await waitPooled(pool!, account);

    const text: string[] = [];
    const thought: string[] = [];
    const out = await runAgentStream(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      (t) => text.push(t),
      undefined,
      "hi",
      account,
      undefined,
      (t) => thought.push(t),
    );

    expect(text).toEqual(["hello"]);
    expect(thought).toEqual(["think"]);
    expect(runAcpStream).not.toHaveBeenCalled();
    expect(out.code).toBe(0);
    expect(out.poolHit).toBe(true);
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: true,
      coldSpawn: false,
    });
  });

  it("cold-falls back on pool miss and marks coldSpawn", async () => {
    initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
    });
    vi.mocked(runAcpStream).mockImplementation(
      async (_cmd, _args, _prompt, _opts, onChunk) => {
        onChunk("cold-stream");
        return { code: 0, stderr: "" };
      },
    );

    const account = poolAccountKey("/tmp/cursor-proxy-pool-stream/acc-miss");
    const chunks: string[] = [];
    const out = await runAgentStream(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      (t) => chunks.push(t),
      undefined,
      "hi",
      account,
    );

    expect(chunks).toEqual(["cold-stream"]);
    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(out.poolHit).toBeFalsy();
    expect(out.poolObservation).toMatchObject({
      eligible: true,
      hit: false,
      coldSpawn: true,
    });
    expect(["empty", "warming"]).toContain(out.poolObservation?.missReason);
  });

  it("allows cold fallback when prompt fails before any chunk", async () => {
    const account = poolAccountKey("/tmp/cursor-proxy-pool-stream/acc-early");
    const fakeConn = {
      id: "stream-early",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => ({
        sessionId: "sess-early",
        createdAt: Date.now(),
        sessionCwd: undefined,
        effectiveModel: "composer-2.5",
      }),
      promptOnce: async () => {
        throw new Error("fail before chunk");
      },
    } as unknown as AcpConnection;

    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await pool!.ensureWarm(account, "composer-2.5");
    await waitPooled(pool!, account);

    vi.mocked(runAcpStream).mockResolvedValue({ code: 0, stderr: "" });

    const out = await runAgentStream(
      baseConfig(),
      cwd,
      true,
      ["acp", "--mode", "ask", "--model", "composer-2.5"],
      () => undefined,
      undefined,
      "hi",
      account,
    );

    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(out.poolObservation).toMatchObject({
      missReason: "prompt_failed",
      coldSpawn: true,
      hit: false,
    });
  });
});
