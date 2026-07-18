import * as fs from "node:fs";

import { admitColdSpawn } from "./admission.js";
import { shouldDisableForPlanUpgrade } from "./account-failure.js";
import { normalizePoolModelKey } from "./acp-connection.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import type { PoolRequestObservation } from "./pool-metrics.js";
import { run, runStreaming } from "./process.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";
import {
  getSessionPool,
  poolAccountKey,
  type VirginSessionPool,
} from "./acp-session-pool.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Thought channel text when ACP emitted agent_thought_chunk (route decides drop/forward). */
  reasoning?: string;
  latencyMarks?: Record<string, number>;
  /** True when served by virgin session pool (not a latency timestamp). */
  poolHit?: boolean;
  /** Combined text safe for account-failure classification */
  failureText?: string;
  /**
   * Eligible-pool outcome for this attempt. Handlers must call
   * recordFinalPoolObservation once after account-retry settles.
   */
  poolObservation?: PoolRequestObservation;
  /** Cold spawn denied — handlers map to 503 before SSE commit. */
  admissionDenied?: boolean;
  retryAfterMs?: number;
};

type PoolStreamCallbacks = {
  onChunk: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
};

type PoolAttempt = {
  /** Non-null when pool fully served (or committed stream failure / plan-upgrade). */
  result: AgentRunResult | null;
  /** Null when request is ineligible for pool metrics. */
  observation: PoolRequestObservation | null;
};

export type AgentStreamResult = {
  code: number;
  stderr: string;
  poolHit?: boolean;
  poolObservation?: PoolRequestObservation;
  latencyMarks?: Record<string, number>;
  admissionDenied?: boolean;
  retryAfterMs?: number;
};

function poolWaitBudget(config: BridgeConfig): number {
  return Math.max(0, config.poolWaitMs ?? 1500);
}

function admissionDeniedResult(
  observation: PoolRequestObservation,
  retryAfterMs: number,
  waitMs: number,
): AgentRunResult {
  const queueWaitMs = (observation.queueWaitMs ?? 0) + waitMs;
  const obs: PoolRequestObservation = {
    ...observation,
    hit: false,
    coldSpawn: false,
    missReason: "admission_denied",
    queueWaitMs,
  };
  return {
    code: 1,
    stdout: "",
    stderr: "cold_spawn_capacity",
    failureText: "cold_spawn_capacity",
    admissionDenied: true,
    retryAfterMs,
    poolObservation: obs,
  };
}

function inventoryFor(
  pool: VirginSessionPool,
  accountKey: string,
): Pick<PoolRequestObservation, "idle" | "warming" | "checkedOut"> {
  const s = pool.stats()[accountKey] ?? {
    pooled: 0,
    warming: 0,
    checkedOut: 0,
  };
  return {
    idle: s.pooled,
    warming: s.warming,
    checkedOut: s.checkedOut,
  };
}

/** Pool prompt catch → quarantine signal or null (cold fallback). Exported for unit tests. */
export function agentResultFromPoolPromptError(
  err: unknown,
): AgentRunResult | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (shouldDisableForPlanUpgrade({ text: msg, fromErrorChannel: true })) {
    return {
      code: 1,
      stdout: "",
      stderr: msg,
      failureText: msg,
      poolHit: true,
    };
  }
  return null;
}

function agentResultFromAcpError(err: unknown): AgentRunResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { code: 1, stdout: "", stderr: msg, failureText: msg };
}

function appendErrorToStderr(
  stderr: string,
  err: unknown,
): { code: number; stderr: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const combined = [stderr, msg].filter(Boolean).join("\n");
  return { code: 1, stderr: combined };
}

function acpArgsWithModel(acpArgs: string[], model: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--model", model, ...acpArgs.slice(i + 1)];
}

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  // cursor-agent only accepts --mode plan|ask; agent mode is the default.
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

function extractModeFromCmdArgs(cmdArgs: string[]): CursorExecutionMode {
  const i = cmdArgs.indexOf("--mode");
  const m =
    i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
  if (m === "agent" || m === "ask" || m === "plan") return m;
  return "ask";
}

async function trySessionPool(
  config: BridgeConfig,
  stdinPrompt: string,
  cmdArgs: string[],
  configDir: string | undefined,
  signal: AbortSignal | undefined,
  effectiveChatOnly: boolean,
  stream?: PoolStreamCallbacks,
): Promise<PoolAttempt> {
  const pool = getSessionPool();
  if (!pool?.enabled || !config.useAcp) {
    return { result: null, observation: null };
  }
  // Pool is chat-only / ask-mode / non-max only (Fable B1/B2).
  if (!effectiveChatOnly) return { result: null, observation: null };
  if (config.maxMode) return { result: null, observation: null };
  const mode = extractModeFromCmdArgs(cmdArgs);
  if (mode !== "ask") return { result: null, observation: null };
  if (signal?.aborted) return { result: null, observation: null };

  const accountKey = poolAccountKey(configDir);
  const acpModel = extractModelFromCmdArgs(cmdArgs);
  const modelKey = normalizePoolModelKey(acpModel, config.defaultModel);
  // Kick refill; briefly wait for inventory before falling through to cold.
  const waitBudget = poolWaitBudget(config);
  const waitStarted = Date.now();
  const detailed = await pool.waitForCheckout(
    accountKey,
    acpModel,
    waitBudget,
    signal,
  );
  const queueWaitMs = Date.now() - waitStarted;
  const inv = inventoryFor(pool, accountKey);
  const baseObs: Omit<
    PoolRequestObservation,
    "hit" | "coldSpawn" | "missReason"
  > & {
    missReason?: PoolRequestObservation["missReason"];
  } = {
    eligible: true,
    accountKey,
    modelKey,
    ...inv,
    ...(queueWaitMs > 0 ? { queueWaitMs } : {}),
  };

  if (!detailed.ok) {
    console.log(
      `[acp-pool] miss account=${accountKey} reason=${detailed.reason} → cold ACP`,
    );
    return {
      result: null,
      observation: {
        ...baseObs,
        hit: false,
        missReason: detailed.reason,
        coldSpawn: false,
      },
    };
  }

  const checkout = detailed.value;
  let discarded = false;
  const discardOnce = async () => {
    if (discarded) return;
    discarded = true;
    try {
      await checkout.discard();
    } catch {
      /* ignore */
    }
  };

  if (checkout.conn.isDead) {
    console.warn(
      `[acp-pool] dead conn on checkout account=${accountKey} → cold ACP`,
    );
    await discardOnce();
    return {
      result: null,
      observation: {
        ...baseObs,
        hit: false,
        missReason: "dead",
        coldSpawn: false,
      },
    };
  }

  let streamCommitted = false;
  const wrapChunk =
    (cb?: (text: string) => void) =>
    (text: string) => {
      if (text) streamCommitted = true;
      cb?.(text);
    };

  try {
    const out = await checkout.promptOnce(stdinPrompt, {
      signal,
      onChunk: stream ? wrapChunk(stream.onChunk) : undefined,
      onThoughtChunk: stream ? wrapChunk(stream.onThoughtChunk) : undefined,
    });
    // Empty stdout = demux/protocol failure → cold (Fable B3), unless stream
    // already committed chunks (never splice a second cold answer into SSE).
    if (!out.stdout.trim()) {
      console.warn(
        `[acp-pool] empty stdout account=${accountKey} → ${
          stream && streamCommitted ? "fail closed" : "cold ACP"
        }`,
      );
      await discardOnce();
      const failObs: PoolRequestObservation = {
        ...baseObs,
        hit: false,
        missReason: "prompt_failed",
        coldSpawn: false,
      };
      if (stream && streamCommitted) {
        return {
          result: {
            code: 1,
            stdout: "",
            stderr: "empty stdout after streamed chunks",
            failureText: "empty stdout after streamed chunks",
            poolObservation: failObs,
          },
          observation: failObs,
        };
      }
      return { result: null, observation: failObs };
    }
    await discardOnce();
    if (signal?.aborted) {
      return { result: null, observation: null };
    }
    cacheTokenForAccount(configDir);
    const hitObs: PoolRequestObservation = {
      ...baseObs,
      hit: true,
      coldSpawn: false,
    };
    return {
      result: {
        code: 0,
        stdout: out.stdout,
        stderr: "",
        ...(out.reasoning ? { reasoning: out.reasoning } : {}),
        latencyMarks: out.latencyMarks,
        poolHit: true,
        poolObservation: hitObs,
      },
      observation: hitObs,
    };
  } catch (err) {
    await discardOnce();
    const planFail = agentResultFromPoolPromptError(err);
    if (planFail) {
      console.warn(
        `[acp-pool] plan-upgrade on prompt, skip cold fallback:`,
        err,
      );
      const hitObs: PoolRequestObservation = {
        ...baseObs,
        hit: true,
        coldSpawn: false,
      };
      return {
        result: { ...planFail, poolObservation: hitObs },
        observation: hitObs,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const failObs: PoolRequestObservation = {
      ...baseObs,
      hit: false,
      missReason: "prompt_failed",
      coldSpawn: false,
    };
    if (stream && streamCommitted) {
      console.warn(
        `[acp-pool] prompt failed after stream commit, no cold fallback:`,
        err,
      );
      return {
        result: {
          code: 1,
          stdout: "",
          stderr: msg,
          failureText: msg,
          poolObservation: failObs,
        },
        observation: failObs,
      };
    }
    console.warn(`[acp-pool] prompt failed, discard + cold fallback:`, err);
    return { result: null, observation: failObs };
  }
}

export async function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  /** Fail closed on cold ACP when the requested model cannot be pinned (fast lane). */
  requireExactModel?: boolean,
): Promise<AgentRunResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const attempt = await trySessionPool(
      config,
      stdinPrompt,
      cmdArgs,
      configDir,
      signal,
      effectiveChatOnly,
    );
    if (attempt.result) {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return attempt.result;
    }

    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    const acpEnv = { ...config.acpEnv };
    if (effectiveChatOnly) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    const skipAuthenticate =
      config.acpSkipAuthenticate ||
      Boolean(acpEnv.CURSOR_API_KEY?.trim() || acpEnv.CURSOR_AUTH_TOKEN?.trim());

    let releaseAdmit: (() => void) | undefined;
    let coldObs: PoolRequestObservation | undefined;
    if (attempt.observation) {
      const admit = await admitColdSpawn(attempt.observation.accountKey ?? "default", {
        signal,
        waitMs: poolWaitBudget(config),
      });
      if (!admit.ok) {
        cleanupTempDir(tempDir);
        return admissionDeniedResult(
          attempt.observation,
          admit.retryAfterMs,
          admit.waitMs,
        );
      }
      releaseAdmit = admit.release;
      coldObs = {
        ...attempt.observation,
        coldSpawn: true,
        hit: false,
        queueWaitMs:
          (attempt.observation.queueWaitMs ?? 0) + admit.waitMs,
      };
    }

    try {
      const out = await runAcpSync(config.acpCommand, args, stdinPrompt, {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: acpEnv,
        model: acpModel,
        requestTimeoutMs: 60_000,
        spawnOptions: config.acpSpawnOptions,
        skipAuthenticate,
        rawDebug: config.acpRawDebug,
        signal,
        requireExactModel,
      });
      cacheTokenForAccount(configDir);
      cleanupTempDir(tempDir);
      // failureText is error-channel only — never copy success stdout (mis-quarantine).
      const base = out.stderr ? { ...out, failureText: out.stderr } : out;
      return coldObs ? { ...base, poolObservation: coldObs } : base;
    } catch (err) {
      cleanupTempDir(tempDir);
      const failed = agentResultFromAcpError(err);
      return coldObs ? { ...failed, poolObservation: coldObs } : failed;
    } finally {
      releaseAdmit?.();
    }
  }
  const runEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: stdinPrompt,
    envOverrides: runEnvOverrides,
    configDir,
    signal,
  }).then((out) => {
    cacheTokenForAccount(configDir);
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}

export type StreamLineHandler = (line: string) => void;

function cleanupTempDir(tempDir?: string): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export async function runAgentStream(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  onThought?: StreamLineHandler,
  /** Fail closed on cold ACP when the requested model cannot be pinned (fast lane). */
  requireExactModel?: boolean,
): Promise<AgentStreamResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const attempt = await trySessionPool(
      config,
      stdinPrompt,
      cmdArgs,
      configDir,
      signal,
      effectiveChatOnly,
      {
        onChunk: onLine,
        onThoughtChunk: onThought,
      },
    );
    if (attempt.result) {
      cleanupTempDir(tempDir);
      return {
        code: attempt.result.code,
        stderr: attempt.result.stderr,
        poolHit: attempt.result.poolHit,
        poolObservation: attempt.result.poolObservation,
        latencyMarks: attempt.result.latencyMarks,
      };
    }

    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    const acpEnv = { ...config.acpEnv };
    if (effectiveChatOnly) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    const skipAuthenticate =
      config.acpSkipAuthenticate ||
      Boolean(acpEnv.CURSOR_API_KEY?.trim() || acpEnv.CURSOR_AUTH_TOKEN?.trim());

    let releaseAdmit: (() => void) | undefined;
    let coldObs: PoolRequestObservation | undefined;
    if (attempt.observation) {
      const admit = await admitColdSpawn(attempt.observation.accountKey ?? "default", {
        signal,
        waitMs: poolWaitBudget(config),
      });
      if (!admit.ok) {
        cleanupTempDir(tempDir);
        const denied = admissionDeniedResult(
          attempt.observation,
          admit.retryAfterMs,
          admit.waitMs,
        );
        return {
          code: denied.code,
          stderr: denied.stderr,
          admissionDenied: true,
          retryAfterMs: denied.retryAfterMs,
          poolObservation: denied.poolObservation,
        };
      }
      releaseAdmit = admit.release;
      coldObs = {
        ...attempt.observation,
        coldSpawn: true,
        hit: false,
        queueWaitMs:
          (attempt.observation.queueWaitMs ?? 0) + admit.waitMs,
      };
    }

    try {
      const result = await runAcpStream(
        config.acpCommand,
        args,
        stdinPrompt,
        {
          cwd: workspaceDir,
          timeoutMs: config.timeoutMs,
          env: acpEnv,
          model: acpModel,
          requestTimeoutMs: 60_000,
          spawnOptions: config.acpSpawnOptions,
          skipAuthenticate,
          rawDebug: config.acpRawDebug,
          signal,
          requireExactModel,
        },
        onLine,
        onThought,
      );
      cacheTokenForAccount(configDir);
      cleanupTempDir(tempDir);
      return coldObs ? { ...result, poolObservation: coldObs } : result;
    } catch (err) {
      cleanupTempDir(tempDir);
      const failed = appendErrorToStderr("", err);
      return coldObs ? { ...failed, poolObservation: coldObs } : failed;
    } finally {
      releaseAdmit?.();
    }
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  const result = await runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
    stdinContent: stdinPrompt,
    envOverrides: streamEnvOverrides,
    configDir,
    signal,
  });
  cacheTokenForAccount(configDir);
  cleanupTempDir(tempDir);
  return result;
}
