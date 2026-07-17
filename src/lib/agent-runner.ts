import * as fs from "node:fs";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";
import { getSessionPool, poolAccountKey } from "./acp-session-pool.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  latencyMarks?: Record<string, number>;
  /** True when served by virgin session pool (not a latency timestamp). */
  poolHit?: boolean;
};

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

async function trySessionPoolSync(
  config: BridgeConfig,
  stdinPrompt: string,
  cmdArgs: string[],
  configDir: string | undefined,
  signal: AbortSignal | undefined,
  effectiveChatOnly: boolean,
): Promise<AgentRunResult | null> {
  const pool = getSessionPool();
  if (!pool?.enabled || !config.useAcp) return null;
  // Pool is chat-only / ask-mode / non-max only (Fable B1/B2).
  if (!effectiveChatOnly) return null;
  if (config.maxMode) return null;
  const mode = extractModeFromCmdArgs(cmdArgs);
  if (mode !== "ask") return null;
  if (signal?.aborted) return null;

  const accountKey = poolAccountKey(configDir);
  const acpModel = extractModelFromCmdArgs(cmdArgs);
  // Refill is async / off request path; never await warm on the hot path.
  void pool.ensureWarm(accountKey, acpModel);
  const checkout = pool.checkout(accountKey, acpModel);
  if (!checkout) {
    console.log(`[acp-pool] miss account=${accountKey} → cold ACP`);
    return null;
  }
  if (checkout.conn.isDead) {
    console.warn(
      `[acp-pool] dead conn on checkout account=${accountKey} → cold ACP`,
    );
    try {
      await checkout.discard();
    } catch {
      /* ignore */
    }
    return null;
  }
  try {
    const out = await checkout.promptOnce(stdinPrompt, { signal });
    // Empty stdout = demux/protocol failure → cold (Fable B3).
    if (!out.stdout.trim()) {
      console.warn(
        `[acp-pool] empty stdout account=${accountKey} → cold ACP`,
      );
      await checkout.discard();
      return null;
    }
    await checkout.discard();
    if (signal?.aborted) return null;
    cacheTokenForAccount(configDir);
    return {
      code: 0,
      stdout: out.stdout,
      stderr: "",
      latencyMarks: out.latencyMarks,
      poolHit: true,
    };
  } catch (err) {
    console.warn(`[acp-pool] prompt failed, discard + cold fallback:`, err);
    try {
      await checkout.discard();
    } catch {
      /* ignore */
    }
    return null;
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
): Promise<AgentRunResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const pooled = await trySessionPoolSync(
      config,
      stdinPrompt,
      cmdArgs,
      configDir,
      signal,
      effectiveChatOnly,
    );
    if (pooled) {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return pooled;
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
    return runAcpSync(config.acpCommand, args, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      env: acpEnv,
      model: acpModel,
      requestTimeoutMs: 60_000,
      spawnOptions: config.acpSpawnOptions,
      skipAuthenticate: config.acpSkipAuthenticate,
      rawDebug: config.acpRawDebug,
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

export function runAgentStream(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    const acpEnv = { ...config.acpEnv };
    if (effectiveChatOnly) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    return runAcpStream(
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
        skipAuthenticate: config.acpSkipAuthenticate,
        rawDebug: config.acpRawDebug,
        signal,
      },
      onLine,
    ).then((result) => {
      cacheTokenForAccount(configDir);
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return result;
    });
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  return runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
    stdinContent: stdinPrompt,
    envOverrides: streamEnvOverrides,
    configDir,
    signal,
  }).then((result) => {
    cacheTokenForAccount(configDir);
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return result;
  });
}
