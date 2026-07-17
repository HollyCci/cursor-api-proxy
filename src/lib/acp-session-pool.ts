/**
 * Virgin one-shot ACP session pool (Fable blockers applied).
 *
 * - Per-account env (CURSOR_CONFIG_DIR etc.)
 * - Strict model match; per-session empty cwd
 * - Prewarm → checkout → one prompt → cancel/discard → async refill
 * - Pool miss / bad hit → null (caller cold-starts)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  AcpConnection,
  normalizePoolModelKey,
} from "./acp-connection.js";

export type SessionPoolConfig = {
  enabled: boolean;
  minIdle: number;
  maxSessions: number;
  idleTtlMs: number;
  command: string;
  args: string[];
  /** Base env shared by all accounts (e.g. CURSOR_API_KEY). */
  env?: Record<string, string | undefined>;
  /**
   * Per-account spawn env overlay. accountKey is the full config dir path
   * or "default".
   */
  resolveAccountEnv?: (
    accountKey: string,
  ) => Record<string, string | undefined>;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  skipAuthenticate?: boolean;
  defaultModel?: string;
};

type SlotState = "warming" | "pooled" | "checked_out" | "dead";

type Slot = {
  accountKey: string;
  conn: AcpConnection;
  sessionId: string;
  state: SlotState;
  createdAt: number;
  /** Normalized effective model key (never undefined when pooled). */
  model: string;
  sessionCwd?: string;
};

export type PoolCheckout = {
  accountKey: string;
  sessionId: string;
  conn: AcpConnection;
  effectiveModel: string;
  promptOnce: (
    prompt: string,
    opts?: {
      onChunk?: (text: string) => void;
      onThoughtChunk?: (text: string) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{
    stdout: string;
    reasoning?: string;
    latencyMarks: Record<string, number>;
  }>;
  discard: () => Promise<void>;
};

/** Stable pool process cwd per account (not used as session workspace). */
function poolProcessCwd(accountKey: string): string {
  const hash = createHash("sha256").update(accountKey).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "cursor-api-proxy-session-pool", hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmSessionCwd(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export class VirginSessionPool {
  private readonly cfg: SessionPoolConfig;
  private readonly slots = new Map<string, Slot[]>();
  private readonly refillInFlight = new Set<string>();
  private readonly connections = new Map<string, AcpConnection>();
  private readonly connecting = new Map<string, Promise<AcpConnection>>();

  constructor(cfg: SessionPoolConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  stats(): Record<string, { pooled: number; warming: number; checkedOut: number }> {
    const out: Record<
      string,
      { pooled: number; warming: number; checkedOut: number }
    > = {};
    for (const [k, list] of this.slots) {
      out[k] = { pooled: 0, warming: 0, checkedOut: 0 };
      for (const s of list) {
        if (s.state === "pooled") out[k].pooled++;
        else if (s.state === "warming") out[k].warming++;
        else if (s.state === "checked_out") out[k].checkedOut++;
      }
    }
    return out;
  }

  async ensureWarm(accountKey: string, model?: string): Promise<void> {
    if (!this.cfg.enabled) return;
    const key = accountKey || "default";
    const modelKey = normalizePoolModelKey(model, this.cfg.defaultModel);
    this.evictExpired(key);
    const list = this.slots.get(key) ?? [];
    const idle = list.filter(
      (s) => s.state === "pooled" && s.model === modelKey,
    ).length;
    const warming = list.filter(
      (s) => s.state === "warming" && s.model === modelKey,
    ).length;
    const need = Math.max(0, this.cfg.minIdle - idle - warming);
    for (let i = 0; i < need; i++) {
      void this.refillOne(key, modelKey).catch((err) => {
        console.warn(`[acp-pool] refill failed account=${key}:`, err);
      });
    }
  }

  /**
   * Atomically take one pooled virgin session with strict model match, or null.
   */
  checkout(accountKey: string, model?: string): PoolCheckout | null {
    if (!this.cfg.enabled) return null;
    const key = accountKey || "default";
    const modelKey = normalizePoolModelKey(model, this.cfg.defaultModel);
    this.evictExpired(key);
    const list = this.slots.get(key) ?? [];
    const idx = list.findIndex(
      (s) =>
        s.state === "pooled" &&
        !s.conn.isDead &&
        s.model === modelKey,
    );
    if (idx < 0) {
      void this.ensureWarm(key, model);
      return null;
    }
    const slot = list[idx]!;
    slot.state = "checked_out";
    console.log(
      `[acp-pool] checkout hit account=${key} session=${slot.sessionId} model=${slot.model} conn=${slot.conn.id}`,
    );

    const discard = async () => {
      slot.state = "dead";
      try {
        await slot.conn.cancel(slot.sessionId);
      } catch {
        /* ignore */
      }
      rmSessionCwd(slot.sessionCwd);
      this.removeSlot(key, slot.sessionId);
      void this.ensureWarm(key, model);
    };

    return {
      accountKey: key,
      sessionId: slot.sessionId,
      conn: slot.conn,
      effectiveModel: slot.model,
      promptOnce: (prompt, opts) =>
        slot.conn.promptOnce(slot.sessionId, prompt, opts),
      discard,
    };
  }

  shutdown(): void {
    for (const list of this.slots.values()) {
      for (const s of list) {
        rmSessionCwd(s.sessionCwd);
      }
    }
    for (const conn of this.connections.values()) {
      conn.kill();
    }
    this.connections.clear();
    this.connecting.clear();
    this.slots.clear();
  }

  private removeSlot(accountKey: string, sessionId: string): void {
    const list = this.slots.get(accountKey);
    if (!list) return;
    const next = list.filter((s) => s.sessionId !== sessionId);
    if (next.length) this.slots.set(accountKey, next);
    else this.slots.delete(accountKey);
  }

  private evictExpired(accountKey: string): void {
    const list = this.slots.get(accountKey);
    if (!list) return;
    const now = Date.now();
    const keep: Slot[] = [];
    for (const s of list) {
      if (
        s.state === "pooled" &&
        (s.conn.isDead || now - s.createdAt > this.cfg.idleTtlMs)
      ) {
        s.state = "dead";
        void s.conn.cancel(s.sessionId).catch(() => undefined);
        rmSessionCwd(s.sessionCwd);
        continue;
      }
      if (s.state !== "dead") keep.push(s);
    }
    this.slots.set(accountKey, keep);
  }

  private async getOrStartConn(accountKey: string): Promise<AcpConnection> {
    const existing = this.connections.get(accountKey);
    if (existing && !existing.isDead) return existing;

    const inflight = this.connecting.get(accountKey);
    if (inflight) return inflight;

    const start = (async () => {
      const cwd = poolProcessCwd(accountKey);
      const accountEnv = this.cfg.resolveAccountEnv?.(accountKey) ?? {};
      const env = { ...this.cfg.env, ...accountEnv };
      const conn = await AcpConnection.start({
        command: this.cfg.command,
        args: this.cfg.args,
        cwd,
        env,
        spawnOptions: this.cfg.spawnOptions,
        skipAuthenticate: this.cfg.skipAuthenticate,
        accountKey,
      });
      this.connections.set(accountKey, conn);
      return conn;
    })();

    this.connecting.set(accountKey, start);
    try {
      return await start;
    } finally {
      this.connecting.delete(accountKey);
    }
  }

  private async refillOne(
    accountKey: string,
    modelKey: string,
  ): Promise<void> {
    const list = this.slots.get(accountKey) ?? [];
    const live = list.filter((s) => s.state !== "dead").length;
    if (live >= this.cfg.maxSessions) return;

    const flightKey = `${accountKey}:${modelKey}`;
    if (this.refillInFlight.has(flightKey)) return;
    this.refillInFlight.add(flightKey);

    const warming: Slot = {
      accountKey,
      conn: null as unknown as AcpConnection,
      sessionId: `warming-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      state: "warming",
      createdAt: Date.now(),
      model: modelKey,
    };
    list.push(warming);
    this.slots.set(accountKey, list);

    try {
      const conn = await this.getOrStartConn(accountKey);
      warming.conn = conn;
      const virgin = await conn.createVirginSession(
        modelKey === "__default__" ? undefined : modelKey,
        this.cfg.defaultModel,
      );
      warming.sessionId = virgin.sessionId;
      warming.createdAt = virgin.createdAt;
      warming.sessionCwd = virgin.sessionCwd;
      warming.model = virgin.effectiveModel;
      warming.state = "pooled";
      console.log(
        `[acp-pool] warmed account=${accountKey} session=${virgin.sessionId} model=${virgin.effectiveModel} conn=${conn.id}`,
      );
    } catch (err) {
      warming.state = "dead";
      rmSessionCwd(warming.sessionCwd);
      this.removeSlot(accountKey, warming.sessionId);
      throw err;
    } finally {
      this.refillInFlight.delete(flightKey);
    }
  }
}

let globalPool: VirginSessionPool | null = null;

export function getSessionPool(): VirginSessionPool | null {
  return globalPool;
}

export function initSessionPool(cfg: SessionPoolConfig): VirginSessionPool | null {
  if (globalPool) {
    globalPool.shutdown();
    globalPool = null;
  }
  if (!cfg.enabled) return null;
  globalPool = new VirginSessionPool(cfg);
  console.log(
    `[acp-pool] enabled minIdle=${cfg.minIdle} maxSessions=${cfg.maxSessions} idleTtlMs=${cfg.idleTtlMs}`,
  );
  return globalPool;
}

export function shutdownSessionPool(): void {
  globalPool?.shutdown();
  globalPool = null;
}

/** Account key: resolved absolute config dir, or "default". */
export function poolAccountKey(configDir: string | undefined): string {
  if (!configDir) return "default";
  return path.resolve(configDir);
}
