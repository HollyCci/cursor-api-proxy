import { describe, expect, it } from "vitest";
import {
  LatencyWaterfall,
  spawnSessionShare,
} from "./latency-waterfall.js";

describe("LatencyWaterfall", () => {
  it("computes spans from marks", async () => {
    const w = new LatencyWaterfall();
    w.mark("exec_start");
    w.mark("account_select_start");
    await new Promise((r) => setTimeout(r, 5));
    w.mark("account_select_end");
    w.mark("spawn_start");
    await new Promise((r) => setTimeout(r, 5));
    w.mark("spawn_ready");
    await new Promise((r) => setTimeout(r, 10));
    w.mark("session_ready");
    w.mark("model_first_byte");
    await new Promise((r) => setTimeout(r, 5));
    w.mark("model_complete");
    w.mark("shape_done");
    const spans = w.snapshot().spans;
    expect(spans.account_select).toBeGreaterThan(0);
    expect(spans.spawn).toBeGreaterThan(0);
    expect(spans.session_ready).toBeGreaterThan(0);
    expect(spans.total).toBeGreaterThan(0);
    expect(spawnSessionShare(spans)).toBeGreaterThan(0);
  });

  it("merges agent marks without overwriting", () => {
    const w = new LatencyWaterfall();
    w.mark("spawn_start");
    const agentSpawn = performance.now();
    w.mergeAgentMarks({
      spawn_start: agentSpawn + 1000,
      spawn_ready: agentSpawn + 1005,
      session_ready: agentSpawn + 2000,
    });
    expect(w.has("spawn_ready")).toBe(true);
    // original handler mark kept
    const marks = w.markOffsets();
    expect(marks.spawn_start).toBeDefined();
  });
});
