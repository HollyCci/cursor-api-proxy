/**
 * Bounded cold-spawn admission: global + per-account permits with short wait.
 */

export type AdmissionConfig = {
  maxColdSpawns: number;
  maxColdSpawnsPerAccount: number;
  poolWaitMs: number;
};

export type AdmitColdSpawnResult =
  | { ok: true; release: () => void; waitMs: number }
  | { ok: false; retryAfterMs: number; waitMs: number };

type Waiter = {
  accountKey: string;
  resolve: (ok: boolean) => void;
  deadline: number;
};

const DEFAULTS: AdmissionConfig = {
  maxColdSpawns: 2,
  maxColdSpawnsPerAccount: 1,
  poolWaitMs: 1500,
};

let cfg: AdmissionConfig = { ...DEFAULTS };
let globalInUse = 0;
const perAccountInUse = new Map<string, number>();
const waiters: Waiter[] = [];

export function configureAdmission(partial: Partial<AdmissionConfig>): void {
  cfg = {
    maxColdSpawns: Math.max(0, partial.maxColdSpawns ?? cfg.maxColdSpawns),
    maxColdSpawnsPerAccount: Math.max(
      0,
      partial.maxColdSpawnsPerAccount ?? cfg.maxColdSpawnsPerAccount,
    ),
    poolWaitMs: Math.max(0, partial.poolWaitMs ?? cfg.poolWaitMs),
  };
}

export function getAdmissionConfig(): AdmissionConfig {
  return { ...cfg };
}

export function resetAdmissionForTests(): void {
  cfg = { ...DEFAULTS };
  globalInUse = 0;
  perAccountInUse.clear();
  while (waiters.length) {
    const w = waiters.shift();
    w?.resolve(false);
  }
}

function accountInUse(accountKey: string): number {
  return perAccountInUse.get(accountKey) ?? 0;
}

function canAcquire(accountKey: string): boolean {
  if (cfg.maxColdSpawns <= 0) return false;
  if (globalInUse >= cfg.maxColdSpawns) return false;
  if (accountInUse(accountKey) >= cfg.maxColdSpawnsPerAccount) return false;
  return true;
}

function acquire(accountKey: string): () => void {
  globalInUse++;
  perAccountInUse.set(accountKey, accountInUse(accountKey) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalInUse = Math.max(0, globalInUse - 1);
    const n = accountInUse(accountKey) - 1;
    if (n <= 0) perAccountInUse.delete(accountKey);
    else perAccountInUse.set(accountKey, n);
    wakeWaiters();
  };
}

function wakeWaiters(): void {
  const now = Date.now();
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i]!;
    if (now >= w.deadline) {
      waiters.splice(i, 1);
      w.resolve(false);
      continue;
    }
    if (canAcquire(w.accountKey)) {
      waiters.splice(i, 1);
      w.resolve(true);
      continue;
    }
    i++;
  }
}

function sleepUntil(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Acquire a cold-spawn permit for accountKey, waiting up to poolWaitMs.
 * Always call release() exactly once when ok.
 */
export async function admitColdSpawn(
  accountKey: string,
  opts?: { signal?: AbortSignal; waitMs?: number },
): Promise<AdmitColdSpawnResult> {
  const key = accountKey || "default";
  const budget = opts?.waitMs ?? cfg.poolWaitMs;
  const started = Date.now();

  if (opts?.signal?.aborted) {
    return { ok: false, retryAfterMs: 1, waitMs: 0 };
  }

  if (canAcquire(key)) {
    const release = acquire(key);
    return { ok: true, release, waitMs: 0 };
  }

  if (budget <= 0) {
    return {
      ok: false,
      retryAfterMs: Math.max(1, Math.ceil(cfg.poolWaitMs / 1000) * 1000),
      waitMs: 0,
    };
  }

  const deadline = started + budget;
  let settled = false;
  const got = await new Promise<boolean>((resolve) => {
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const waiter: Waiter = { accountKey: key, resolve: finish, deadline };
    waiters.push(waiter);
    const remaining = Math.max(0, deadline - Date.now());
    void sleepUntil(remaining, opts?.signal).then((timedOutOk) => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      if (!timedOutOk || opts?.signal?.aborted) {
        finish(false);
        return;
      }
      finish(canAcquire(key));
    });
  });

  const waitMs = Date.now() - started;
  if (opts?.signal?.aborted) {
    return { ok: false, retryAfterMs: 1, waitMs };
  }
  if (got && canAcquire(key)) {
    const release = acquire(key);
    return { ok: true, release, waitMs };
  }
  const retryAfterMs = Math.max(1, Math.ceil(cfg.poolWaitMs / 1000) * 1000);
  return { ok: false, retryAfterMs, waitMs };
}

/** Snapshot for tests / status. */
export function getAdmissionSnapshot(): {
  globalInUse: number;
  perAccount: Record<string, number>;
  waiting: number;
} {
  return {
    globalInUse,
    perAccount: Object.fromEntries(perAccountInUse),
    waiting: waiters.length,
  };
}
