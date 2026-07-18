# Pool Hit + Admission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise eligible `pool_hit` for both sync and stream by adding pool metrics, pooled streaming, inventory-aware account selection with bounded admission, a strict `cursor-fast` model lane, and gateway-home isolation.

**Architecture:** Keep virgin one-shot ACP sessions. Extend `VirginSessionPool` with inventory queries, continuous refill to `minIdle`, and miss reasons. Route sync and stream through one checkout/prompt/discard path. Make `AccountPool` prefer accounts that already hold a matching idle session, and admit cold spawns only under a global/per-account cap with short wait-then-503. Pin `cursor-fast` to one canonical model and stop inheriting the previous request's model for that lane.

**Tech Stack:** TypeScript, Node.js 18+, Vitest, existing ACP session pool / account pool / handlers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-pool-hit-and-admission-design.md`
- Never re-pool a session after `promptOnce` (virgin one-shot).
- Do not reverse-engineer Cursor private protocols; do not build hosted key resale.
- Do not replace ACP with `@cursor/sdk` in this plan (optional spike only after Tasks 1–4 land).
- Eligible pool traffic = `useAcp` + chat-only + ask mode + non-max + non-tool-bridge (unless tool-bridge already buffers full response and can share checkout).
- Prefer measurement: every change must expose or use `pool_eligible` / miss reason.
- Plan-disable / rate-limit semantics from `2026-07-18-account-plan-disable` remain in force (disabled ≫ rate-limit).

---

## File Structure

```text
src/lib/pool-metrics.ts                 # structured counters + event helpers
src/lib/pool-metrics.test.ts
src/lib/acp-session-pool.ts             # inventory, refill fix, missReason, stream checkout
src/lib/acp-session-pool.test.ts
src/lib/account-pool.ts                 # pool-aware getNext + cold-spawn gates
src/lib/account-pool.test.ts
src/lib/admission.ts                    # global/per-account cold spawn semaphore + short wait
src/lib/admission.test.ts
src/lib/agent-runner.ts                 # shared trySessionPool for sync+stream
src/lib/agent-runner.test.ts
src/lib/resolve-model.ts                # cursor-fast lane; stop cross-client model bleed
src/lib/resolve-model.test.ts
src/lib/handlers/chat-completions.ts    # wire metrics, admission, stream pool
src/lib/handlers/anthropic-messages.ts  # same
src/lib/admin-dashboard.ts              # /api/status pool inventory
src/lib/workspace.ts / server.ts        # gateway HOME isolation
src/cli/... or src/lib/doctor.ts        # doctor checks
README.md                               # cursor-fast + env knobs
```

---

### Task 1: Pool metrics + miss reasons

**Files:**
- Create: `src/lib/pool-metrics.ts`
- Create: `src/lib/pool-metrics.test.ts`
- Modify: `src/lib/acp-session-pool.ts` (return miss reason from checkout)
- Modify: `src/lib/admin-dashboard.ts` (`/api/status.pool`)

**Interfaces:**
- Produces:
```ts
export type PoolMissReason =
  | "disabled"
  | "ineligible"
  | "empty"
  | "model_mismatch"
  | "warming"
  | "dead"
  | "capacity"
  | "not_enabled";

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

export function recordPoolObservation(obs: PoolRequestObservation): void;
export function getPoolMetricsSnapshot(): {
  eligible: number;
  hits: number;
  misses: Record<string, number>;
  coldSpawns: number;
};
```
- `VirginSessionPool.checkout` becomes:
```ts
checkout(accountKey: string, model?: string):
  | { ok: true; value: PoolCheckout }
  | { ok: false; reason: PoolMissReason }
```
  (or keep `PoolCheckout | null` and add `checkoutDetailed` — prefer one detailed API and adapt call sites).

- [ ] **Step 1: Write failing tests** for metrics counters and miss reason `empty` vs `warming`.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPoolObservation,
  getPoolMetricsSnapshot,
  resetPoolMetrics,
} from "./pool-metrics.js";

describe("pool-metrics", () => {
  beforeEach(() => resetPoolMetrics());

  it("tracks eligible hit rate components", () => {
    recordPoolObservation({
      eligible: true,
      hit: true,
      idle: 1,
      warming: 0,
      checkedOut: 0,
      coldSpawn: false,
    });
    recordPoolObservation({
      eligible: true,
      hit: false,
      missReason: "empty",
      idle: 0,
      warming: 1,
      checkedOut: 0,
      coldSpawn: true,
    });
    const s = getPoolMetricsSnapshot();
    expect(s.eligible).toBe(2);
    expect(s.hits).toBe(1);
    expect(s.misses.empty).toBe(1);
    expect(s.coldSpawns).toBe(1);
  });
});
```

- [ ] **Step 2:** `npm test -- src/lib/pool-metrics.test.ts` → FAIL

- [ ] **Step 3:** Implement `pool-metrics.ts`; extend pool checkout to report `warming` when only warming slots exist for model; log one line per eligible request (not verbose-gated):

```text
[pool] eligible=true hit=false reason=empty account=acc1 model=composer-2.5 idle=0 warming=1 checkedOut=0 cold=1
```

Expose on `/api/status`:

```ts
pool: {
  enabled: boolean;
  metrics: ReturnType<typeof getPoolMetricsSnapshot>;
  inventory: Record<string, { pooled: number; warming: number; checkedOut: number }>; // from existing stats()
}
```

- [ ] **Step 4:** PASS tests + typecheck

- [ ] **Step 5: Commit**

```bash
git add src/lib/pool-metrics.ts src/lib/pool-metrics.test.ts src/lib/acp-session-pool.ts src/lib/admin-dashboard.ts
git commit -m "feat: add pool eligible/hit/miss metrics and status inventory"
```

---

### Task 2: Fix refill so MIN_IDLE is reachable

**Files:**
- Modify: `src/lib/acp-session-pool.ts` (`ensureWarm` / `refillOne`)
- Modify: `src/lib/acp-session-pool.test.ts`

**Interfaces:**
- Consumes: existing `minIdle`, `maxSessions`, epoch/disabled gates
- Produces: after `ensureWarm(account, model)` settles, idle+warming for that model reaches `minIdle` (subject to `maxSessions`), not stuck at 1 because of `refillInFlight` de-dupe.

- [ ] **Step 1: Failing test** — with fake `startConnection`, `ensureWarm` with `minIdle=2` creates 2 pooled sessions.

```ts
it("ensureWarm fills up to minIdle for a model", async () => {
  const pool = new VirginSessionPool({
    enabled: true,
    minIdle: 2,
    maxSessions: 4,
    idleTtlMs: 60_000,
    command: "false",
    args: [],
    startConnection: fakeStartConnection, // existing test seam
  });
  await pool.ensureWarm("acc1", "composer-2.5");
  // wait until no warming
  await waitFor(() => pool.stats()["acc1"]?.pooled === 2);
  expect(pool.stats()["acc1"]?.pooled).toBe(2);
});
```

- [ ] **Step 2:** Run test → FAIL (today only 1)

- [ ] **Step 3: Implementation**

Change `refillInFlight` from a boolean Set to a **count** or allow N concurrent refills per `(account, model)` up to `need`:

```ts
// Option A (preferred): track inFlightCount
private readonly refillInFlightCount = new Map<string, number>();

private async refillOne(...): Promise<void> {
  const flightKey = `${accountKey}:${modelKey}`;
  const n = this.refillInFlightCount.get(flightKey) ?? 0;
  // allow up to minIdle concurrent warms for that key
  if (n >= this.cfg.minIdle) return;
  this.refillInFlightCount.set(flightKey, n + 1);
  try {
    // ... existing warm ...
  } finally {
    const cur = (this.refillInFlightCount.get(flightKey) ?? 1) - 1;
    if (cur <= 0) this.refillInFlightCount.delete(flightKey);
    else this.refillInFlightCount.set(flightKey, cur);
  }
}
```

After successful warm or discard, if still below `minIdle`, schedule another `ensureWarm` (already called from discard).

- [ ] **Step 4:** PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "fix: allow session pool refill to reach minIdle"
```

---

### Task 3: Shared virgin checkout for sync + stream

**Files:**
- Modify: `src/lib/agent-runner.ts`
- Modify: `src/lib/agent-runner.test.ts`
- Modify: `src/lib/handlers/chat-completions.ts` (stream paths use runner pool result)
- Modify: `src/lib/handlers/anthropic-messages.ts`
- Modify: `src/lib/server-thought.test.ts` / add `server-pool-stream.test.ts` if needed

**Interfaces:**
- Consumes: `PoolCheckout.promptOnce({ onChunk, onThoughtChunk, signal })`
- Produces:
```ts
async function trySessionPool(
  ...same args as trySessionPoolSync,
  stream?: {
    onChunk: (text: string) => void;
    onThoughtChunk?: (text: string) => void;
  },
): Promise<AgentRunResult | null>
```
- `runAgentStream` must call `trySessionPool` first when eligible; on hit, feed chunks via callbacks and return `{ code:0, stderr:"", poolHit:true }` (stdout may be accumulated for handlers that need it).

- [ ] **Step 1: Failing unit test** with mocked pool: `runAgentStream` invokes `onLine` from pooled `promptOnce` and sets `poolHit`.

- [ ] **Step 2:** FAIL

- [ ] **Step 3: Implementation**

Refactor `trySessionPoolSync` → `trySessionPool` accepting optional stream callbacks:

```ts
const out = await checkout.promptOnce(stdinPrompt, {
  signal,
  onChunk: stream?.onChunk,
  onThoughtChunk: stream?.onThoughtChunk,
});
```

In `runAgentStream`, before cold `runAcpStream`:

```ts
const pooled = await trySessionPool(..., { onChunk: onLine, onThoughtChunk: onThought });
if (pooled) return { code: pooled.code, stderr: pooled.stderr ?? "" };
// existing cold path
```

Record metrics: hit/miss + `coldSpawn` when falling through.

**Do not** change virgin semantics: still discard after one prompt.

- [ ] **Step 4:** `npm test` green; add HTTP test that mocks runner to assert stream path can set pool_hit log if exposed, or unit-level is enough for this task.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: serve streaming requests from virgin ACP session pool"
```

---

### Task 4: Pool-aware account selection + admission control

**Files:**
- Create: `src/lib/admission.ts`
- Create: `src/lib/admission.test.ts`
- Modify: `src/lib/account-pool.ts`
- Modify: `src/lib/acp-session-pool.ts` (`hasIdle(accountKey, model)`, `listAccountsWithIdle(model)`)
- Modify: handlers to select account with model in mind **after** model resolution
- Modify: `src/lib/env.ts` / `config.ts` for:
  - `CURSOR_BRIDGE_MAX_COLD_SPAWNS` (global, default e.g. 2)
  - `CURSOR_BRIDGE_POOL_WAIT_MS` (default e.g. 1500)
  - `CURSOR_BRIDGE_MAX_INFLIGHT` (optional global)

**Interfaces:**
```ts
// account-pool.ts
getNextConfigDir(opts?: {
  preferAccountKeys?: string[]; // inventory-aware order hint
}): string | undefined;

// Better: 
selectAccountForModel(modelKey: string): string | undefined;
// implementation: among non-disabled, prefer keys from pool.hasIdle, then least busy

// admission.ts
export async function admitColdSpawn(accountKey: string): Promise<
  | { ok: true; release: () => void }
  | { ok: false; retryAfterMs: number }
>;
```

- [ ] **Step 1: Tests**

```ts
it("prefers account with idle virgin session for model", () => {
  // accA idle for composer-2.5, accB empty → select accA even if accB lastUsed older
});

it("rejects cold spawn when global cold cap exceeded", async () => {
  const a = await admitColdSpawn("a");
  const b = await admitColdSpawn("b");
  // with max=1, second fails with retryAfterMs > 0
});
```

- [ ] **Step 2:** FAIL

- [ ] **Step 3: Implementation**

Handler order (chat + anthropic):

1. Resolve canonical model  
2. `selectAccountForModel(model)`  
3. Try pool checkout  
4. On miss: `await pool.waitForIdle?(account, model, waitMs)` **or** briefly `ensureWarm` + sleep/poll inventory (cap wait)  
5. Retry checkout once  
6. Else `admitColdSpawn` → cold ACP; on deny → 429/503 JSON (or SSE error if headers already sent) with `Retry-After`

Default: **do not** infinite cold fallback under load.

Wire `recordPoolObservation` with `queueWaitMs`.

- [ ] **Step 4:** PASS + document env in README

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: prefer pooled accounts and bound cold ACP spawns"
```

---

### Task 5: `cursor-fast` lane + model hygiene

**Files:**
- Modify: `src/lib/resolve-model.ts`
- Modify: `src/lib/resolve-model.test.ts`
- Modify: `src/lib/env.ts`, `config.ts`
- Modify: `src/lib/server.ts` warm targets
- Modify: README

**Interfaces:**
```ts
// env
cursorFastModel: string; // default "composer-2.5"
// when request model is "cursor-fast" | "fast" | alias → canonical cursorFastModel

// resolveModel:
// - if lane is fast, NEVER fall back to lastRequestedModelRef from another lane
// - optional: config.strictModel true for fast lane always
```

- [ ] **Step 1: Tests**

```ts
it("cursor-fast ignores lastRequestedModelRef from previous auto request", () => {
  const ref = { current: "grok-4.5" };
  const m = resolveModel("cursor-fast", ref, configWithFast);
  expect(m).toBe("composer-2.5");
});

it("unspecified model under fastDefault uses fast canonical", () => {
  // only if env CURSOR_BRIDGE_DEFAULT_MODEL=composer-2.5 already; document that
  // Singapore should set defaultModel=composer-2.5 (already true)
});
```

- [ ] **Step 2–4:** Implement alias map; warm **only** canonical fast model at boot (or warm defaultModel + explicitly configured extras). Fix: requests with omitted model must use `config.defaultModel`, and if `strictModel` is on, do not read `lastRequestedModelRef` unless same client continuity is explicitly desired — **Sol: stop bleed**. Change:

```ts
// resolve-model.ts — recommended behavior
resolved =
  normalizeAlias(requested) ??
  (config.strictModel ? undefined : undefined) ??
  config.defaultModel;
// Remove using lastRequestedModelRef for omitted model OR gate it behind CURSOR_BRIDGE_STICKY_MODEL=true (default false)
```

Document breaking change: sticky last model becomes opt-in.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add cursor-fast model lane and disable sticky model by default"
```

---

### Task 6: Gateway HOME isolation + doctor

**Files:**
- Modify: `src/lib/workspace.ts` (`getChatOnlyEnvOverrides`)
- Modify: `src/lib/server.ts` (pool `resolveAccountEnv`)
- Create: `src/lib/doctor.ts` + CLI hook `cursor-api-proxy doctor` if CLI already has subcommands
- Tests: `workspace.test.ts`

**Interfaces:**
```ts
getChatOnlyEnvOverrides(workspaceDir, authConfigDir?): Record<string, string | undefined>
// Always set for gateway:
// HOME / USERPROFILE → per-account or per-process empty gateway home
// CURSOR_CONFIG_DIR → authConfigDir (account)
// Do NOT early-return in a way that skips HOME override when authConfigDir is set
```

- [ ] **Step 1: Failing test** — with `authConfigDir` set, overrides still include isolated `HOME`.

- [ ] **Step 2–4:** Implement gateway homes under `os.tmpdir()/cursor-api-proxy-home/<hash>` with minimal files; copy only auth material if required (token cache already per config dir). Doctor checks: agent bin, ACP enabled, default model, pool enabled, each account dir exists, sample `stats()`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: isolate gateway Cursor HOME and add doctor checks"
```

---

### Task 7: Singapore verification script (ops)

**Files:**
- Create: `scripts/verify-pool-hit.mjs` (or `.ts` run via node)

**Behavior:** against `http://127.0.0.1:8765` with bridge key:

1. GET `/api/status` → print accounts + pool  
2. N=20 sync short prompts `composer-2.5` → parse logs or response headers for pool_hit if exposed; else rely on journal grep  
3. N=10 stream short prompts  
4. Print hit rate + latency p50

Expose `X-Cursor-Proxy-Pool-Hit: 0|1` and `X-Cursor-Proxy-Pool-Miss-Reason` on sync responses (and trailer/comment in stream if easy) so the script does not need journal access.

- [ ] **Step 1–4:** Add headers in chat-completions sync path; stream: log line is enough initially  
- [ ] **Step 5: Commit**

```bash
git commit -m "chore: add pool-hit verification script and response headers"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| pool_eligible / miss reason / inventory | 1 |
| MIN_IDLE actually reachable | 2 |
| stream uses virgin pool | 3 |
| pool-aware scheduling + cold cap | 4 |
| cursor-fast + no sticky bleed | 5 |
| gateway HOME + doctor | 6 |
| Singapore verify | 7 |
| no SDK rewrite / no reverse eng | Global Constraints |

## Self-review notes

- Sticky-model default flip is intentional and documented in Task 5.  
- Tool-bridge may remain ineligible for pool in v1 if buffering already cold-spawns; note in Task 3 if skipped.  
- `/v1/responses` and Docker explicitly out of this plan.

---

## Execution Handoff

Plan complete at `docs/superpowers/plans/2026-07-18-pool-hit-and-admission.md`.

**1. Subagent-Driven (recommended)** — fresh subagent per task  
**2. Inline Execution** — this session with checkpoints  

Which approach?
