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
  type AcpConnectionOptions,
} from "./acp-connection.js";
import type { PoolMissReason } from "./pool-metrics.js";

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
  /** When set, warm slots for this model use requireExactModel (cursor-fast lane). */
  fastModel?: string;
  /** Test seam: override ACP connection start (avoids real/fake spawn). */
  startConnection?: (opts: AcpConnectionOptions) => Promise<AcpConnection>;
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

export type PoolCheckoutResult =
  | { ok: true; value: PoolCheckout }
  | { ok: false; reason: PoolMissReason };

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

const REFILL_MAX_ATTEMPTS = 3;
/** Backoff after attempt 1 and 2 failures (ms). */
const REFILL_BACKOFF_MS = [100, 300] as const;

export class VirginSessionPool {
  private readonly cfg: SessionPoolConfig;
  private readonly slots = new Map<string, Slot[]>();
  /** Concurrent warm count per `${accountKey}:${modelKey}`; capped at minIdle. */
  private readonly refillInFlightCount = new Map<string, number>();
  /** One converge loop per `${accountKey}:${modelKey}` (coalesces concurrent ensureWarm). */
  private readonly ensureWarmInFlight = new Map<string, Promise<void>>();
  private readonly connections = new Map<string, AcpConnection>();
  private readonly connecting = new Map<string, Promise<AcpConnection>>();
  private readonly disabledAccounts = new Set<string>();
  private readonly accountEpoch = new Map<string, number>();
  private stopped = false;

  constructor(cfg: SessionPoolConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private epochOf(accountKey: string): number {
    return this.accountEpoch.get(accountKey) ?? 0;
  }

  isAccountDisabled(accountKey: string): boolean {
    return this.disabledAccounts.has(accountKey || "default");
  }

  disableAccount(accountKey: string): void {
    const key = accountKey || "default";
    this.disabledAccounts.add(key);
    this.accountEpoch.set(key, this.epochOf(key) + 1);
    const list = this.slots.get(key) ?? [];
    for (const s of [...list]) {
      if (s.state === "pooled") {
        s.state = "dead";
        void s.conn.cancel(s.sessionId).catch(() => undefined);
        rmSessionCwd(s.sessionCwd);
        this.removeSlot(key, s.sessionId);
      }
      // warming: leave; refillOne checks epoch before pooling
      // checked_out: leave; discard must not refill
    }
    this.maybeKillConnIfDisabledIdle(key);
  }

  enableAccount(accountKey: string): void {
    this.disabledAccounts.delete(accountKey || "default");
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
    if (!this.cfg.enabled || this.stopped) return;
    const key = accountKey || "default";
    if (this.disabledAccounts.has(key)) return;
    const modelKey = normalizePoolModelKey(model, this.cfg.defaultModel);
    const flightKey = `${key}:${modelKey}`;
    const existing = this.ensureWarmInFlight.get(flightKey);
    if (existing) return existing;

    const run = this.convergeWarm(key, modelKey).finally(() => {
      if (this.ensureWarmInFlight.get(flightKey) === run) {
        this.ensureWarmInFlight.delete(flightKey);
      }
    });
    this.ensureWarmInFlight.set(flightKey, run);
    return run;
  }

  private calculateRefillNeed(accountKey: string, modelKey: string): number {
    if (this.stopped || this.disabledAccounts.has(accountKey)) return 0;
    this.evictExpired(accountKey);
    const list = this.slots.get(accountKey) ?? [];
    const matchingPooled = list.filter(
      (s) => s.state === "pooled" && s.model === modelKey,
    ).length;
    const matchingWarming = list.filter(
      (s) => s.state === "warming" && s.model === modelKey,
    ).length;
    const allLive = list.filter((s) => s.state !== "dead").length;
    return Math.min(
      Math.max(0, this.cfg.minIdle - matchingPooled - matchingWarming),
      Math.max(0, this.cfg.maxSessions - allLive),
    );
  }

  private async sleepMs(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Fill matching idle sessions up to minIdle (subject to maxSessions), with
   * bounded retries on transient refill failures. Never rejects.
   */
  private async convergeWarm(
    accountKey: string,
    modelKey: string,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < REFILL_MAX_ATTEMPTS; attempt++) {
      if (this.stopped || this.disabledAccounts.has(accountKey)) return;

      const need = this.calculateRefillNeed(accountKey, modelKey);
      if (need <= 0) return;

      const results = await Promise.allSettled(
        Array.from({ length: need }, () =>
          this.refillOne(accountKey, modelKey),
        ),
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (rejected.length === 0) {
        if (this.calculateRefillNeed(accountKey, modelKey) <= 0) return;
        // Gap remains without failures (capacity / other models) — stop.
        return;
      }
      lastErr = rejected[0]!.reason;
      if (this.calculateRefillNeed(accountKey, modelKey) <= 0) return;
      if (attempt >= REFILL_MAX_ATTEMPTS - 1) break;
      if (this.stopped || this.disabledAccounts.has(accountKey)) return;
      await this.sleepMs(REFILL_BACKOFF_MS[attempt] ?? 300);
    }
    if (lastErr != null) {
      console.warn(
        `[acp-pool] refill exhausted account=${accountKey} model=${modelKey}:`,
        lastErr,
      );
    }
  }

  /**
   * Atomically take one pooled virgin session with strict model match.
   * Reports a structured miss reason when no session is available.
   */
  checkoutDetailed(accountKey: string, model?: string): PoolCheckoutResult {
    if (!this.cfg.enabled) return { ok: false, reason: "not_enabled" };
    const key = accountKey || "default";
    if (this.disabledAccounts.has(key)) {
      return { ok: false, reason: "disabled" };
    }
    const modelKey = normalizePoolModelKey(model, this.cfg.defaultModel);
    const preEvict = this.slots.get(key) ?? [];
    const hadDeadMatch = preEvict.some(
      (s) =>
        s.state === "pooled" &&
        s.model === modelKey &&
        s.conn.isDead,
    );
    this.evictExpired(key);
    const list = this.slots.get(key) ?? [];
    const idx = list.findIndex(
      (s) =>
        s.state === "pooled" &&
        !s.conn.isDead &&
        s.model === modelKey,
    );
    if (idx < 0) {
      const reason = this.classifyMiss(key, modelKey, hadDeadMatch);
      void this.ensureWarm(key, model);
      return { ok: false, reason };
    }
    const slot = list[idx]!;
    slot.state = "checked_out";
    console.log(
      `[acp-pool] checkout hit account=${key} session=${slot.sessionId} model=${slot.model} conn=${slot.conn.id}`,
    );

    const discard = async () => {
      const shouldRefill = !this.disabledAccounts.has(key);
      slot.state = "dead";
      try {
        await slot.conn.cancel(slot.sessionId);
      } catch {
        /* ignore */
      }
      rmSessionCwd(slot.sessionCwd);
      this.removeSlot(key, slot.sessionId);
      if (shouldRefill) void this.ensureWarm(key, model);
      else this.maybeKillConnIfDisabledIdle(key);
    };

    return {
      ok: true,
      value: {
        accountKey: key,
        sessionId: slot.sessionId,
        conn: slot.conn,
        effectiveModel: slot.model,
        promptOnce: (prompt, opts) =>
          slot.conn.promptOnce(slot.sessionId, prompt, opts),
        discard,
      },
    };
  }

  /**
   * Backward-compatible wrapper: returns PoolCheckout or null.
   */
  checkout(accountKey: string, model?: string): PoolCheckout | null {
    const result = this.checkoutDetailed(accountKey, model);
    return result.ok ? result.value : null;
  }

  private classifyMiss(
    accountKey: string,
    modelKey: string,
    hadDeadMatch: boolean,
  ): PoolMissReason {
    if (hadDeadMatch) return "dead";
    const list = this.slots.get(accountKey) ?? [];
    const warmingForModel = list.some(
      (s) => s.state === "warming" && s.model === modelKey,
    );
    if (warmingForModel) return "warming";
    const otherModelIdle = list.some(
      (s) =>
        s.state === "pooled" &&
        !s.conn.isDead &&
        s.model !== modelKey,
    );
    if (otherModelIdle) return "model_mismatch";
    const live = list.filter((s) => s.state !== "dead").length;
    if (live >= this.cfg.maxSessions) return "capacity";
    return "empty";
  }

  shutdown(): void {
    this.stopped = true;
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
    this.refillInFlightCount.clear();
    this.ensureWarmInFlight.clear();
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

  private maybeKillConnIfDisabledIdle(accountKey: string): void {
    if (!this.disabledAccounts.has(accountKey)) return;
    const remaining = this.slots.get(accountKey) ?? [];
    const busy = remaining.some(
      (s) => s.state === "checked_out" || s.state === "warming",
    );
    if (busy) return;
    const conn = this.connections.get(accountKey);
    if (conn) {
      conn.kill();
      this.connections.delete(accountKey);
    }
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
      const opts: AcpConnectionOptions = {
        command: this.cfg.command,
        args: this.cfg.args,
        cwd,
        env,
        spawnOptions: this.cfg.spawnOptions,
        skipAuthenticate: this.cfg.skipAuthenticate,
        accountKey,
      };
      const conn = this.cfg.startConnection
        ? await this.cfg.startConnection(opts)
        : await AcpConnection.start(opts);
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
    if (this.stopped || this.disabledAccounts.has(accountKey)) return;
    const epoch = this.epochOf(accountKey);

    const list = this.slots.get(accountKey) ?? [];
    const live = list.filter((s) => s.state !== "dead").length;
    if (live >= this.cfg.maxSessions) return;

    const flightKey = `${accountKey}:${modelKey}`;
    const inFlight = this.refillInFlightCount.get(flightKey) ?? 0;
    if (inFlight >= this.cfg.minIdle) return;
    this.refillInFlightCount.set(flightKey, inFlight + 1);

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
      const fastKey = this.cfg.fastModel
        ? normalizePoolModelKey(this.cfg.fastModel, this.cfg.defaultModel)
        : undefined;
      const requireExactModel = Boolean(
        fastKey && modelKey === fastKey && modelKey !== "__default__",
      );
      const virgin = await conn.createVirginSession(
        modelKey === "__default__" ? undefined : modelKey,
        this.cfg.defaultModel,
        { requireExactModel },
      );
      warming.sessionId = virgin.sessionId;
      warming.createdAt = virgin.createdAt;
      warming.sessionCwd = virgin.sessionCwd;
      warming.model = virgin.effectiveModel;

      if (
        this.stopped ||
        this.disabledAccounts.has(accountKey) ||
        this.epochOf(accountKey) !== epoch
      ) {
        warming.state = "dead";
        void conn.cancel(virgin.sessionId).catch(() => undefined);
        rmSessionCwd(warming.sessionCwd);
        this.removeSlot(accountKey, warming.sessionId);
        this.maybeKillConnIfDisabledIdle(accountKey);
        return;
      }

      warming.state = "pooled";
      console.log(
        `[acp-pool] warmed account=${accountKey} session=${virgin.sessionId} model=${virgin.effectiveModel} conn=${conn.id}`,
      );
    } catch (err) {
      warming.state = "dead";
      rmSessionCwd(warming.sessionCwd);
      this.removeSlot(accountKey, warming.sessionId);
      this.maybeKillConnIfDisabledIdle(accountKey);
      throw err;
    } finally {
      const cur = (this.refillInFlightCount.get(flightKey) ?? 1) - 1;
      if (cur <= 0) this.refillInFlightCount.delete(flightKey);
      else this.refillInFlightCount.set(flightKey, cur);
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

export function disableSessionPoolAccount(accountKey: string): void {
  getSessionPool()?.disableAccount(accountKey);
}

/** Account key: resolved absolute config dir, or "default". */
export function poolAccountKey(configDir: string | undefined): string {
  if (!configDir) return "default";
  return path.resolve(configDir);
}
