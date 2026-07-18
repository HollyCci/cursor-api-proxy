import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordPoolObservation,
  getPoolMetricsSnapshot,
  resetPoolMetrics,
} from "./pool-metrics.js";

describe("pool-metrics", () => {
  beforeEach(() => {
    resetPoolMetrics();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("ignores ineligible observations for counters and logging", () => {
    recordPoolObservation({
      eligible: false,
      hit: false,
      missReason: "ineligible",
      idle: 0,
      warming: 0,
      checkedOut: 0,
      coldSpawn: false,
    });
    const s = getPoolMetricsSnapshot();
    expect(s.eligible).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.coldSpawns).toBe(0);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs one non-verbose-gated line per eligible observation", () => {
    recordPoolObservation({
      eligible: true,
      hit: false,
      missReason: "empty",
      accountKey: "acc1",
      modelKey: "composer-2.5",
      idle: 0,
      warming: 1,
      checkedOut: 0,
      coldSpawn: true,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "[pool] eligible=true hit=false reason=empty account=acc1 model=composer-2.5 idle=0 warming=1 checkedOut=0 cold=1",
    );
  });
});
