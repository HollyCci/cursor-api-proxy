#!/usr/bin/env node
/**
 * Phase 0 latency bench against a running cursor-api-proxy.
 *
 * Usage:
 *   node scripts/bench-latency.mjs [--n=20] [--target=http://127.0.0.1:8765] [--model=auto] [--key=...]
 *
 * Collects client total + X-Cursor-Proxy-Waterfall header spans.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const n = Number(args.n ?? 20);
const target = String(args.target ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const model = String(args.model ?? "auto");
const apiKey = args.key ?? process.env.CURSOR_BRIDGE_API_KEY ?? "";

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: mean(s),
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    min: s[0],
    max: s[s.length - 1],
  };
}

async function oneRequest(i) {
  const t0 = performance.now();
  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${target}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 8,
      messages: [{ role: "user", content: "只回ok" }],
    }),
  });
  const text = await res.text();
  const totalMs = performance.now() - t0;
  let waterfall = null;
  const wh = res.headers.get("x-cursor-proxy-waterfall");
  if (wh) {
    try {
      waterfall = JSON.parse(wh);
    } catch {
      waterfall = { parse_error: wh };
    }
  }
  let ok = res.ok;
  let preview = text.slice(0, 120).replace(/\s+/g, " ");
  try {
    const j = JSON.parse(text);
    if (j.error) {
      ok = false;
      preview = j.error.message ?? preview;
    } else {
      preview = j.choices?.[0]?.message?.content ?? preview;
    }
  } catch {
    /* keep */
  }
  return { i, ok, status: res.status, totalMs, waterfall, preview };
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(1) : "-";
}

async function main() {
  console.log(`bench-latency target=${target} n=${n} model=${model}`);
  const results = [];
  for (let i = 1; i <= n; i++) {
    try {
      const r = await oneRequest(i);
      results.push(r);
      const w = r.waterfall
        ? ` spawn=${fmt(r.waterfall.spawn)} session=${fmt(r.waterfall.session_ready)} first=${fmt(r.waterfall.model_first_byte)}`
        : " (no waterfall header)";
      console.log(
        `[${i}/${n}] ${r.ok ? "ok" : "FAIL"} ${fmt(r.totalMs)}ms${w} :: ${r.preview}`,
      );
    } catch (err) {
      console.log(`[${i}/${n}] ERROR ${err?.message ?? err}`);
      results.push({ i, ok: false, totalMs: NaN, waterfall: null });
    }
  }

  const ok = results.filter((r) => r.ok && Number.isFinite(r.totalMs));
  const totals = ok.map((r) => r.totalMs);
  const tSum = summarize(totals);

  const spanKeys = [
    "gateway_queue",
    "account_select",
    "spawn",
    "session_ready",
    "model_first_byte",
    "model_complete",
    "shape_response",
    "total",
  ];
  const spanMeans = {};
  for (const k of spanKeys) {
    const vals = ok
      .map((r) => r.waterfall?.[k])
      .filter((v) => typeof v === "number");
    if (vals.length) spanMeans[k] = mean(vals);
  }

  const fixedShares = ok
    .map((r) => {
      const w = r.waterfall;
      if (!w || typeof w.total !== "number" || w.total <= 0) return null;
      return ((w.spawn ?? 0) + (w.session_ready ?? 0)) / w.total;
    })
    .filter((v) => v != null);

  console.log("\n=== Client total (ms) ===");
  console.log(
    `n_ok=${tSum.n}/${n} mean=${fmt(tSum.mean)} p50=${fmt(tSum.p50)} p95=${fmt(tSum.p95)} p99=${fmt(tSum.p99)} min=${fmt(tSum.min)} max=${fmt(tSum.max)}`,
  );

  console.log("\n=== Waterfall mean (ms, from X-Cursor-Proxy-Waterfall) ===");
  if (Object.keys(spanMeans).length === 0) {
    console.log("(no headers — rebuild/restart proxy with latency instrumentation)");
  } else {
    for (const k of spanKeys) {
      if (spanMeans[k] != null) console.log(`  ${k}: ${fmt(spanMeans[k])}`);
    }
    const shareMean = mean(fixedShares);
    console.log(
      `\nGate 0: mean (spawn+session_ready)/total = ${(shareMean * 100).toFixed(1)}% ${shareMean >= 0.6 ? "PASS (≥60%)" : "FAIL (<60%)"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
