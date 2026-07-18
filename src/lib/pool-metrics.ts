export type PoolMissReason =
  | "disabled"
  | "ineligible"
  | "empty"
  | "model_mismatch"
  | "warming"
  | "dead"
  | "capacity"
  | "not_enabled"
  /** Checkout succeeded but prompt empty/threw (not a durable hit). */
  | "prompt_failed"
  /** Cold spawn denied by admission semaphore. */
  | "admission_denied";

export type PoolRequestObservation = {
  eligible: boolean;
  hit: boolean;
  missReason?: PoolMissReason;
  accountKey?: string;
  modelKey?: string;
  idle: number;
  warming: number;
  checkedOut: number;
  coldSpawn: boolean;
  queueWaitMs?: number;
};

type PoolMetricsSnapshot = {
  eligible: number;
  hits: number;
  misses: Record<string, number>;
  coldSpawns: number;
};

const metrics: PoolMetricsSnapshot = {
  eligible: 0,
  hits: 0,
  misses: {},
  coldSpawns: 0,
};

export function resetPoolMetrics(): void {
  metrics.eligible = 0;
  metrics.hits = 0;
  metrics.misses = {};
  metrics.coldSpawns = 0;
}

export function getPoolMetricsSnapshot(): PoolMetricsSnapshot {
  return {
    eligible: metrics.eligible,
    hits: metrics.hits,
    misses: { ...metrics.misses },
    coldSpawns: metrics.coldSpawns,
  };
}

export function recordPoolObservation(obs: PoolRequestObservation): void {
  if (!obs.eligible) return;

  metrics.eligible++;
  if (obs.hit) metrics.hits++;
  if (!obs.hit && obs.missReason) {
    metrics.misses[obs.missReason] = (metrics.misses[obs.missReason] ?? 0) + 1;
  }
  if (obs.coldSpawn) metrics.coldSpawns++;

  const reason = obs.hit ? "hit" : (obs.missReason ?? "unknown");
  const account = obs.accountKey ?? "-";
  const model = obs.modelKey ?? "-";
  const cold = obs.coldSpawn ? 1 : 0;
  console.log(
    `[pool] eligible=true hit=${obs.hit} reason=${reason} account=${account} model=${model} idle=${obs.idle} warming=${obs.warming} checkedOut=${obs.checkedOut} cold=${cold}`,
  );
}

/** Handlers call once after account-retry settles (final AgentRunResult only). */
export function recordFinalPoolObservation(
  obs: PoolRequestObservation | undefined,
): void {
  if (obs) recordPoolObservation(obs);
}
