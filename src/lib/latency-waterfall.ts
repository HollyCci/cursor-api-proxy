/**
 * Per-request latency waterfall for Phase 0+ measurement.
 * Spans are milliseconds from mark A → mark B (or t0 → mark when from omitted).
 */

export type LatencySpanName =
  | "gateway_queue"
  | "account_select"
  | "spawn"
  | "session_ready"
  | "model_first_byte"
  | "model_complete"
  | "shape_response"
  | "total";

export type LatencySnapshot = {
  spans: Partial<Record<LatencySpanName, number>>;
  marks: Record<string, number>;
  /** Absolute epoch ms when the tracker started (for log correlation). */
  startedAt: number;
};

const SPAN_PAIRS: Array<[LatencySpanName, string, string]> = [
  ["gateway_queue", "handler_enter", "exec_start"],
  ["account_select", "account_select_start", "account_select_end"],
  ["spawn", "spawn_start", "spawn_ready"],
  ["session_ready", "spawn_ready", "session_ready"],
  ["model_first_byte", "session_ready", "model_first_byte"],
  ["model_complete", "model_first_byte", "model_complete"],
  ["shape_response", "model_complete", "shape_done"],
  ["total", "handler_enter", "done"],
];

export class LatencyWaterfall {
  readonly startedAt = Date.now();
  private readonly t0 = performance.now();
  private readonly marks = new Map<string, number>();

  constructor() {
    this.mark("handler_enter");
  }

  mark(name: string): void {
    if (!this.marks.has(name)) {
      this.marks.set(name, performance.now());
    }
  }

  /** Force-update a mark (e.g. first byte may fire once). */
  markForce(name: string): void {
    this.marks.set(name, performance.now());
  }

  has(name: string): boolean {
    return this.marks.has(name);
  }

  /** Merge agent marks (same-process `performance.now()` values). */
  mergeAgentMarks(agent: Record<string, number> | undefined): void {
    if (!agent) return;
    for (const [k, v] of Object.entries(agent)) {
      if (typeof v === "number" && !this.marks.has(k)) {
        this.marks.set(k, v);
      }
    }
  }

  /** Absolute mark times relative to tracker t0 (ms). */
  markOffsets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.marks) {
      out[k] = roundMs(v - this.t0);
    }
    return out;
  }

  spans(): Partial<Record<LatencySpanName, number>> {
    const out: Partial<Record<LatencySpanName, number>> = {};
    for (const [span, from, to] of SPAN_PAIRS) {
      const a = this.marks.get(from);
      const b = this.marks.get(to);
      if (a != null && b != null && b >= a) {
        out[span] = roundMs(b - a);
      }
    }
    return out;
  }

  snapshot(): LatencySnapshot {
    this.mark("done");
    return {
      spans: this.spans(),
      marks: this.markOffsets(),
      startedAt: this.startedAt,
    };
  }

  headerValue(): string {
    return JSON.stringify(this.snapshot().spans);
  }

  logLine(extra?: Record<string, unknown>): void {
    const snap = this.snapshot();
    console.log(
      `[latency] ${JSON.stringify({ ...snap.spans, marks: snap.marks, ...extra })}`,
    );
  }
}

/** Agent-side mark bag (offsets from agent-local t0 via performance.now()). */
export type AgentLatencyMarks = {
  spawn_start: number;
  spawn_ready?: number;
  session_ready?: number;
  model_first_byte?: number;
  model_complete?: number;
};

export function createAgentLatencyBag(): {
  t0: number;
  marks: Partial<AgentLatencyMarks>;
  mark: (name: keyof AgentLatencyMarks) => void;
  absoluteMarks: () => Record<string, number>;
} {
  const t0 = performance.now();
  const marks: Partial<AgentLatencyMarks> = {};
  return {
    t0,
    marks,
    mark(name) {
      if (marks[name] == null) marks[name] = performance.now();
    },
    absoluteMarks() {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(marks)) {
        if (typeof v === "number") out[k] = v;
      }
      return out;
    },
  };
}

function roundMs(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Share of spawn+session_ready over total (0–1). */
export function spawnSessionShare(
  spans: Partial<Record<LatencySpanName, number>>,
): number | undefined {
  const total = spans.total;
  if (total == null || total <= 0) return undefined;
  const fixed = (spans.spawn ?? 0) + (spans.session_ready ?? 0);
  return fixed / total;
}
