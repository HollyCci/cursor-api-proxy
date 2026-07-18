import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  admitColdSpawn,
  configureAdmission,
  getAdmissionSnapshot,
  resetAdmissionForTests,
} from "./admission.js";

describe("admitColdSpawn", () => {
  beforeEach(() => {
    resetAdmissionForTests();
    configureAdmission({
      maxColdSpawns: 2,
      maxColdSpawnsPerAccount: 1,
      poolWaitMs: 50,
    });
  });

  afterEach(() => {
    resetAdmissionForTests();
  });

  it("grants up to global max then rejects", async () => {
    const a = await admitColdSpawn("acc-a", { waitMs: 0 });
    const b = await admitColdSpawn("acc-b", { waitMs: 0 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const c = await admitColdSpawn("acc-c", { waitMs: 0 });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.retryAfterMs).toBeGreaterThan(0);
    if (a.ok) a.release();
    if (b.ok) b.release();
  });

  it("enforces per-account cap of 1", async () => {
    configureAdmission({
      maxColdSpawns: 4,
      maxColdSpawnsPerAccount: 1,
      poolWaitMs: 0,
    });
    const first = await admitColdSpawn("same");
    expect(first.ok).toBe(true);
    const second = await admitColdSpawn("same", { waitMs: 0 });
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    const third = await admitColdSpawn("same", { waitMs: 0 });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("release is idempotent and frees capacity", async () => {
    configureAdmission({
      maxColdSpawns: 1,
      maxColdSpawnsPerAccount: 1,
      poolWaitMs: 0,
    });
    const a = await admitColdSpawn("x");
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(getAdmissionSnapshot().globalInUse).toBe(0);
    const b = await admitColdSpawn("y", { waitMs: 0 });
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
  });

  it("waiter acquires after release within budget", async () => {
    configureAdmission({
      maxColdSpawns: 1,
      maxColdSpawnsPerAccount: 1,
      poolWaitMs: 200,
    });
    const held = await admitColdSpawn("a");
    expect(held.ok).toBe(true);
    const pending = admitColdSpawn("b", { waitMs: 200 });
    await new Promise((r) => setTimeout(r, 20));
    if (held.ok) held.release();
    const got = await pending;
    expect(got.ok).toBe(true);
    if (got.ok) got.release();
  });
});
