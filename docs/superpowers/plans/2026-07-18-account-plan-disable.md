# Account Plan-Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Cursor account returns plan-upgrade / subscription-dead signals, permanently disable that account in-process, drain its ACP pool, and stop scheduling it until process restart or manual enable.

**Architecture:** A pure `account-failure` classifier feeds `AccountPool` (permanent `disabled` flag, never fall back to disabled accounts) and `VirginSessionPool` (per-account epoch + refill gate). Handlers apply classification on stderr/stdout/RPC errors, return `503` + `no_usable_accounts` when none remain, and allow one pre-bytes failover.

**Tech Stack:** TypeScript, Node.js 18+, Vitest, existing `AccountPool` / `VirginSessionPool` / chat+anthropic handlers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-account-plan-disable-design.md`
- Do not delete local `configDir` / credentials; do not persist disable to disk.
- Do not treat ordinary 429 as plan upgrade.
- Never cross-request reuse a prompted session (virgin one-shot unchanged).
- Error code for zero usable accounts is exactly `no_usable_accounts` (HTTP 503).
- Matching primary anchor: `/upgrade your plan/i` — never bare `plan to continue` alone.
- Default-on structured disable log (not gated by `CURSOR_BRIDGE_VERBOSE`).
- First version: no admin UI / CLI enable; keep `reportAccountEnabled` + `enableAccount` APIs.
- One failover max, and only if no model content bytes have been written to the client.

---

## File Structure

```text
src/lib/account-failure.ts              # classifyAccountFailure + shouldDisableForPlanUpgrade
src/lib/account-failure.test.ts
src/lib/account-pool.ts                 # disabled state + scheduling
src/lib/account-pool.test.ts
src/lib/acp-session-pool.ts             # epoch, disableAccount, discardAccount, refill gate
src/lib/acp-session-pool.test.ts        # new or extend if present
src/lib/account-quarantine.ts           # glue: disable pool + session pool + log
src/lib/agent-runner.ts                 # surface err.message into stderr; classify pool stdout
src/lib/handlers/chat-completions.ts    # 503, apply quarantine, failover, stream abort
src/lib/handlers/anthropic-messages.ts  # same
src/lib/admin-dashboard.ts              # /api/status accounts capacity
README.md                               # one-line ops note: restart clears disable
```

---

### Task 1: Account failure classifier

**Files:**
- Create: `src/lib/account-failure.ts`
- Create: `src/lib/account-failure.test.ts`

**Interfaces:**
- Produces:
  - `export type AccountFailureKind = "plan_upgrade" | "rate_limit" | "other"`
  - `export function classifyAccountFailure(text: string | undefined | null): AccountFailureKind`
  - `export function shouldDisableForPlanUpgrade(opts: { text: string; exitCode?: number; fromErrorChannel?: boolean }): boolean`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  classifyAccountFailure,
  shouldDisableForPlanUpgrade,
} from "./account-failure.js";

describe("classifyAccountFailure", () => {
  it("detects upgrade your plan before rate limit", () => {
    expect(
      classifyAccountFailure("Upgrade your plan to continue\n429 rate limit"),
    ).toBe("plan_upgrade");
  });

  it("detects rate limit", () => {
    expect(classifyAccountFailure("Error 429 too many requests")).toBe(
      "rate_limit",
    );
  });

  it("does not treat bare plan to continue as upgrade", () => {
    expect(classifyAccountFailure("Please plan to continue tomorrow")).toBe(
      "other",
    );
  });
});

describe("shouldDisableForPlanUpgrade", () => {
  it("disables short error-channel upgrade text", () => {
    expect(
      shouldDisableForPlanUpgrade({
        text: "Upgrade your plan to continue",
        fromErrorChannel: true,
      }),
    ).toBe(true);
  });

  it("disables short stdout that is almost only the upgrade sentence", () => {
    expect(
      shouldDisableForPlanUpgrade({
        text: "Upgrade your plan to continue",
        exitCode: 0,
        fromErrorChannel: false,
      }),
    ).toBe(true);
  });

  it("does not disable long success text that mentions upgrade", () => {
    const long = `${"x".repeat(400)} Upgrade your plan to continue ${"y".repeat(400)}`;
    expect(
      shouldDisableForPlanUpgrade({
        text: long,
        exitCode: 0,
        fromErrorChannel: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests (expect FAIL)**

Run: `npm test -- src/lib/account-failure.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement classifier**

```ts
// src/lib/account-failure.ts
export type AccountFailureKind = "plan_upgrade" | "rate_limit" | "other";

const PLAN_UPGRADE_RE = /upgrade your plan/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;

export function classifyAccountFailure(
  text: string | undefined | null,
): AccountFailureKind {
  if (!text) return "other";
  if (PLAN_UPGRADE_RE.test(text)) return "plan_upgrade";
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  return "other";
}

/** False-positive guard: long success bodies that merely mention billing. */
export function shouldDisableForPlanUpgrade(opts: {
  text: string;
  exitCode?: number;
  fromErrorChannel?: boolean;
}): boolean {
  const text = opts.text.trim();
  if (!text || !PLAN_UPGRADE_RE.test(text)) return false;
  if (opts.fromErrorChannel) return true;
  if (typeof opts.exitCode === "number" && opts.exitCode !== 0) return true;
  // Short assistant/stdout that is essentially the upgrade message.
  return text.length <= 120;
}
```

- [ ] **Step 4: Run tests (expect PASS)**

Run: `npm test -- src/lib/account-failure.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/account-failure.ts src/lib/account-failure.test.ts
git commit -m "feat: classify Cursor plan-upgrade account failures"
```

---

### Task 2: AccountPool permanent disable

**Files:**
- Modify: `src/lib/account-pool.ts`
- Modify: `src/lib/account-pool.test.ts`

**Interfaces:**
- Consumes: none from Task 1 (pool stays dumb about text)
- Produces:
  - `reportAccountDisabled(configDir?: string, reason?: string): void`
  - `reportAccountEnabled(configDir?: string): void`
  - `getUsableCount(): number`
  - `AccountStat` gains `isDisabled`, `disabledReason`, `disabledAt`
  - `getNextConfigDir(): string | undefined` never returns a disabled account; if every account is disabled → `undefined` (even if some are also rate-limited)

- [ ] **Step 1: Write failing tests** (append to `account-pool.test.ts`)

```ts
it("skips permanently disabled accounts", () => {
  const pool = new AccountPool(["/dir1", "/dir2"]);
  pool.reportAccountDisabled("/dir1", "upgrade_plan");
  expect(pool.getNextConfigDir()).toBe("/dir2");
  expect(pool.getNextConfigDir()).toBe("/dir2");
  expect(pool.getUsableCount()).toBe(1);
});

it("returns undefined when all accounts are disabled (no rate-limit fallback)", () => {
  const pool = new AccountPool(["/dir1", "/dir2"]);
  pool.reportAccountDisabled("/dir1", "upgrade_plan");
  pool.reportAccountDisabled("/dir2", "upgrade_plan");
  pool.reportRateLimit("/dir1", 60_000);
  expect(pool.getNextConfigDir()).toBeUndefined();
  expect(pool.getUsableCount()).toBe(0);
});

it("reportAccountEnabled clears disable", () => {
  const pool = new AccountPool(["/dir1", "/dir2"]);
  pool.reportAccountDisabled("/dir1", "upgrade_plan");
  pool.reportAccountEnabled("/dir1");
  expect(pool.getStats().find((s) => s.configDir === "/dir1")?.isDisabled).toBe(
    false,
  );
});
```

- [ ] **Step 2: Run tests (expect FAIL)**

Run: `npm test -- src/lib/account-pool.test.ts`  
Expected: FAIL — methods missing

- [ ] **Step 3: Implement disable fields and scheduling**

In `AccountStatus` add:

```ts
disabled: boolean;
disabledReason: string;
disabledAt: number;
```

Initialize `disabled: false`, `disabledReason: ""`, `disabledAt: 0`.

`getNextConfigDir` rewrite selection:

```ts
const nonDisabled = this.accounts.filter((a) => !a.disabled);
if (nonDisabled.length === 0) return undefined;

const now = Date.now();
const available = nonDisabled.filter((a) => a.rateLimitUntil < now);
const targetAccounts =
  available.length > 0
    ? available
    : [...nonDisabled].sort((a, b) => a.rateLimitUntil - b.rateLimitUntil);

// existing least-busy / lastUsed sort on targetAccounts
```

Add methods + global wrappers mirroring `reportRateLimit`.

`getStats` includes `isDisabled: a.disabled`, `disabledReason`, `disabledAt`.

`getUsableCount`: `this.accounts.filter((a) => !a.disabled).length`.

- [ ] **Step 4: Run tests (expect PASS)**

Run: `npm test -- src/lib/account-pool.test.ts`  
Expected: PASS (including existing rate-limit tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/account-pool.ts src/lib/account-pool.test.ts
git commit -m "feat: permanently skip plan-disabled accounts in pool"
```

---

### Task 3: Session pool epoch + discardAccount

**Files:**
- Modify: `src/lib/acp-session-pool.ts`
- Create or modify: `src/lib/acp-session-pool.test.ts` (unit-test gate logic with fakes if full ACP spawn is heavy; prefer testing `disabled`/`epoch` short-circuits via a thin package-visible helper or by exporting only what tests need)

**Interfaces:**
- Produces on `VirginSessionPool`:
  - `disableAccount(accountKey: string): void` — bump epoch, mark disabled, cancel/remove `pooled` slots, do **not** kill conn while `checked_out` or `warming` > 0
  - `enableAccount(accountKey: string): void` — clear disabled mark (does not auto-warm in this task)
  - `isAccountDisabled(accountKey: string): boolean`
  - `discard` / `ensureWarm` / `checkout` / `refillOne` honor disabled + epoch
- Global: `disableSessionPoolAccount(accountKey: string): void` wrapping `getSessionPool()?.disableAccount`

- [ ] **Step 1: Write failing tests for gate semantics**

If spawning real ACP is too heavy, extract pure helpers used by the pool:

```ts
// Prefer testing through VirginSessionPool methods with injected/mocked connections
// Minimum assertions:
// 1) after disableAccount, checkout returns null and ensureWarm is no-op
// 2) refillOne completion with stale epoch does not leave state===pooled
// 3) PoolCheckout.discard after disable does not call ensureWarm (spy / counter)
```

Concrete starter test (adjust if pool construction needs more stubs):

```ts
it("checkout returns null after disableAccount", () => {
  const pool = new VirginSessionPool({
    enabled: true,
    minIdle: 1,
    maxSessions: 2,
    idleTtlMs: 60_000,
    command: "false",
    args: [],
  });
  pool.disableAccount("/acc1");
  expect(pool.checkout("/acc1", "composer-2.5")).toBeNull();
});
```

- [ ] **Step 2: Run tests (expect FAIL)**

Run: `npm test -- src/lib/acp-session-pool.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement epoch + disableAccount**

Add to class:

```ts
private readonly disabledAccounts = new Set<string>();
private readonly accountEpoch = new Map<string, number>();

private epochOf(accountKey: string): number {
  return this.accountEpoch.get(accountKey) ?? 0;
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
  const remaining = this.slots.get(key) ?? [];
  const busy = remaining.some(
    (s) => s.state === "checked_out" || s.state === "warming",
  );
  if (!busy) {
    const conn = this.connections.get(key);
    if (conn) {
      conn.kill();
      this.connections.delete(key);
    }
  }
}

enableAccount(accountKey: string): void {
  this.disabledAccounts.delete(accountKey || "default");
}
```

At start of `ensureWarm` / `checkout` / `refillOne`:

```ts
if (this.disabledAccounts.has(key)) return; // or null for checkout
```

In `refillOne`, capture `const epoch = this.epochOf(accountKey)` before await; before setting `pooled`:

```ts
if (
  this.disabledAccounts.has(accountKey) ||
  this.epochOf(accountKey) !== epoch
) {
  warming.state = "dead";
  // cancel virgin session if created, rm cwd, removeSlot
  return;
}
```

In `PoolCheckout.discard`:

```ts
const shouldRefill = !this.disabledAccounts.has(key);
// ... cancel, removeSlot ...
if (shouldRefill) void this.ensureWarm(key, model);
// if no busy slots and disabled, kill conn
```

- [ ] **Step 4: Run tests (expect PASS)**

Run: `npm test -- src/lib/acp-session-pool.test.ts src/lib/account-pool.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/acp-session-pool.ts src/lib/acp-session-pool.test.ts
git commit -m "feat: gate ACP pool refill when account is disabled"
```

---

### Task 4: Quarantine glue + default log

**Files:**
- Create: `src/lib/account-quarantine.ts`
- Create: `src/lib/account-quarantine.test.ts`

**Interfaces:**
- Consumes: `reportAccountDisabled`, `getAccountStats` / `getUsableCount`, `poolAccountKey`, `getSessionPool`
- Produces:
  - `export function quarantineAccount(configDir: string | undefined, reason: string): void`
  - Always logs one line (no verbose gate):  
    `[account-quarantine] disabled account=<basename> reason=<reason> usable=<n> disabled=<n> total=<n>`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initAccountPool, getUsableCount, getAccountStats } from "./account-pool.js";
import { quarantineAccount } from "./account-quarantine.js";

describe("quarantineAccount", () => {
  beforeEach(() => {
    initAccountPool(["/tmp/acc-a", "/tmp/acc-b"]);
  });

  it("disables account in AccountPool", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    quarantineAccount("/tmp/acc-a", "upgrade_plan");
    expect(getUsableCount()).toBe(1);
    expect(
      getAccountStats().find((s) => s.configDir === "/tmp/acc-a")?.isDisabled,
    ).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run (expect FAIL)**

Run: `npm test -- src/lib/account-quarantine.test.ts`

- [ ] **Step 3: Implement**

```ts
import path from "node:path";
import {
  reportAccountDisabled,
  getAccountStats,
  getUsableCount,
} from "./account-pool.js";
import { getSessionPool, poolAccountKey } from "./acp-session-pool.js";

export function quarantineAccount(
  configDir: string | undefined,
  reason: string,
): void {
  if (!configDir) return;
  reportAccountDisabled(configDir, reason);
  const key = poolAccountKey(configDir);
  getSessionPool()?.disableAccount(key);
  const stats = getAccountStats();
  const disabledCount = stats.filter((s) => s.isDisabled).length;
  const totalCount = stats.length;
  const usableCount = getUsableCount();
  console.warn(
    `[account-quarantine] disabled account=${path.basename(configDir)} reason=${reason} usable=${usableCount} disabled=${disabledCount} total=${totalCount}`,
  );
}
```

Export `getUsableCount` from `account-pool.ts` if not already done in Task 2.

- [ ] **Step 4: PASS + commit**

```bash
git add src/lib/account-quarantine.ts src/lib/account-quarantine.test.ts src/lib/account-pool.ts
git commit -m "feat: quarantine account in pool and ACP session pool"
```

---

### Task 5: Agent runner surfaces failures for classification

**Files:**
- Modify: `src/lib/agent-runner.ts`

**Interfaces:**
- Consumes: `shouldDisableForPlanUpgrade`, `quarantineAccount` (optional here) **or** only enrich `AgentRunResult` and let handlers quarantine — prefer **handlers call quarantine** using enriched result to keep runner free of HTTP concerns.
- Produces: on pool/ACP catch paths, put `String(err)` into `stderr` (or a new `errorText` field). Prefer adding:

```ts
export type AgentRunResult = {
  // existing fields...
  /** Combined text safe for account-failure classification */
  failureText?: string;
};
```

Rules:
- Pool success: `failureText = stdout` when `shouldDisableForPlanUpgrade({ text: stdout, exitCode: 0 })` would be relevant — handlers will call classifier.
- Pool catch: return `null` for cold fallback **only if** not plan_upgrade; if plan_upgrade, return `{ code: 1, stdout: "", stderr: msg, failureText: msg, poolHit: true }` so handlers can quarantine without cold-retrying the same dead account endlessly. Spec: after quarantine, failover is handler’s job.

Minimal behavior for this task:

```ts
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await checkout.discard();
  if (shouldDisableForPlanUpgrade({ text: msg, fromErrorChannel: true })) {
    return {
      code: 1,
      stdout: "",
      stderr: msg,
      failureText: msg,
      poolHit: true,
    };
  }
  return null; // existing cold fallback
}
```

Also after successful pool prompt, set `failureText: out.stdout` (handlers decide).

For non-pool ACP sync/stream errors, append error message into returned stderr.

- [ ] **Step 1:** Add a focused unit/integration test if `agent-runner` is mockable; otherwise cover via Task 6 HTTP tests. If no new test file, add a small pure helper in runner or rely on Task 6.

- [ ] **Step 2–4:** Implement enrichment; `npm test`; commit:

```bash
git add src/lib/agent-runner.ts
git commit -m "fix: surface ACP plan-upgrade errors for account quarantine"
```

---

### Task 6: Handlers — 503, quarantine, one failover, stream abort

**Files:**
- Modify: `src/lib/handlers/chat-completions.ts`
- Modify: `src/lib/handlers/anthropic-messages.ts`
- Modify: `src/lib/server.test.ts` and/or `src/lib/server-thought.test.ts` patterns as needed
- Create helpers in handler file or `src/lib/account-quarantine.ts`:

```ts
export function applyAgentAccountSignals(
  configDir: string | undefined,
  result: { code: number; stdout: string; stderr: string; failureText?: string },
): "plan_upgrade" | "rate_limit" | "other" {
  const errText = [result.stderr, result.failureText].filter(Boolean).join("\n");
  if (
    shouldDisableForPlanUpgrade({
      text: errText,
      exitCode: result.code,
      fromErrorChannel: true,
    }) ||
    shouldDisableForPlanUpgrade({
      text: result.stdout,
      exitCode: result.code,
      fromErrorChannel: false,
    })
  ) {
    quarantineAccount(configDir, "upgrade_plan");
    return "plan_upgrade";
  }
  if (classifyAccountFailure(errText) === "rate_limit") {
    reportRateLimit(configDir, 60_000);
    return "rate_limit";
  }
  return "other";
}
```

**HTTP 503 shape (lock):**

```json
{
  "error": {
    "message": "No usable Cursor accounts (all disabled)",
    "code": "no_usable_accounts"
  }
}
```

- [ ] **Step 1: Write HTTP failing tests** (extend `server.test.ts` or new `server-account-disable.test.ts`)

Cases:
1. Mock/fake agent returning upgrade on account A → next request uses B (if multi-account fixture available); or unit-test selection after `quarantineAccount`.
2. Disable all accounts via `quarantineAccount` then `POST /v1/chat/completions` → **503** + `no_usable_accounts`, and response is JSON (not SSE) when stream requested **before** headers — for stream path, call `getNext` before `writeSseHeaders`; if undefined, 503 JSON.
3. Long success containing the sentence does not quarantine (classifier unit test already covers; optional HTTP).

Critical handler ordering change in both stream entrypoints:

```ts
const configDir = getNextAccountConfigDir();
if (configDir === undefined && getAccountStats().length > 0 && getUsableCount() === 0) {
  json(res, 503, {
    error: {
      message: "No usable Cursor accounts (all disabled)",
      code: "no_usable_accounts",
    },
  });
  return;
}
// only then writeSseHeaders / run agent
```

Note: today empty pool also yields `undefined`. Distinguish:

```ts
const stats = getAccountStats();
if (!configDir) {
  if (stats.length > 0 && getUsableCount() === 0) {
    // 503 no_usable_accounts
  }
  // else existing single-default-dir behavior (no multi-account)
}
```

Failover (sync path sketch):

```ts
async function runWithAccountFailover(...) {
  let attempts = 0;
  let last;
  while (attempts < 2) {
    const configDir = getNextAccountConfigDir();
    if (!configDir && getUsableCount() === 0 && getAccountStats().length > 0) {
      return { kind: "no_accounts" as const };
    }
    attempts++;
    const out = await runAgentSync(..., configDir, ...);
    const signal = applyAgentAccountSignals(configDir, out);
    if (signal === "plan_upgrade" && attempts < 2 && out code/path had no client write) {
      continue;
    }
    return { kind: "ok" as const, configDir, out };
  }
}
```

Stream: buffer detection on chunks **before** first write when possible; if headers already sent, write SSE error with same `code` and end. No second account after bytes flushed.

Replace local `isRateLimited` usages with `applyAgentAccountSignals`.

- [ ] **Step 2: Run tests FAIL**

Run: `npm test -- src/lib/server.test.ts` (or new file)

- [ ] **Step 3: Implement handler changes**

- [ ] **Step 4: PASS full suite**

Run: `npm test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/handlers/chat-completions.ts src/lib/handlers/anthropic-messages.ts src/lib/account-quarantine.ts src/lib/*.test.ts
git commit -m "feat: quarantine plan-dead accounts and return 503 when none left"
```

---

### Task 7: Observability on `/api/status` + README note

**Files:**
- Modify: `src/lib/admin-dashboard.ts` (`getStatus`)
- Modify: `README.md` (short ops note)

**Interfaces:**
- `/api/status` JSON gains:

```ts
accounts: {
  total: number;
  usable: number;
  disabled: Array<{
    configDir: string; // basename only in response
    reason: string;
    disabledAt: number;
  }>;
  rateLimited: Array<{ configDir: string; until: number }>;
}
```

- [ ] **Step 1:** If status is hard to HTTP-test, unit-test a small `buildAccountCapacityView(stats)` pure helper in `account-pool.ts` or `account-quarantine.ts`.

- [ ] **Step 2:** Wire into `getStatus` via `getAccountStats()`.

- [ ] **Step 3:** README — under ops / accounts:

```markdown
When Cursor returns "Upgrade your plan", the proxy disables that account in-memory
until process restart (or a future manual enable). Check `GET /api/status` → `accounts`.
```

- [ ] **Step 4:** `npm test && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-dashboard.ts README.md src/lib/account-quarantine.ts
git commit -m "feat: expose disabled account capacity on /api/status"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| classify plan_upgrade / rate_limit / other | 1 |
| no bare `plan to continue` | 1 |
| false-positive guard for long success | 1 |
| AccountPool disabled + no fallback to disabled | 2 |
| Session pool discard + ban refill + epoch | 3 |
| quarantine glue + default log | 4 |
| ACP/pool error text reachable | 5 |
| 503 `no_usable_accounts` before SSE headers | 6 |
| stream mid-chunk abort | 6 |
| one pre-bytes failover | 6 |
| `/api/status` capacity | 7 |
| README restart clears disable | 7 |
| no disk persist / no UI enable | honored (APIs only) |

---

## Self-review notes

- Locked error code to `no_usable_accounts` everywhere.
- Rate-limit path remains 60s; plan path never uses rate-limit fallback set.
- Failover explicitly capped at 1 and only pre-bytes.
- Task 5 avoids cold-fallback loops on plan_upgrade by returning a failed `AgentRunResult` instead of `null`.
