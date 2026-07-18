#!/usr/bin/env node
/**
 * Ops verification: pool hit rate + latency against a running proxy.
 *
 * Usage:
 *   node scripts/verify-pool-hit.mjs \
 *     [--target=http://127.0.0.1:8765] [--key=...] \
 *     [--model=composer-2.5] [--sync=20] [--stream=10] \
 *     [--warmup-ms=3000]
 *
 * Requires CURSOR_BRIDGE_SESSION_POOL=true (+ USE_ACP) on the server.
 * Sync paths read X-Cursor-Proxy-Pool-Hit / Miss-Reason headers.
 * Stream paths use /api/status.pool.metrics delta (headers deferred).
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const target = String(args.target ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const model = String(args.model ?? "composer-2.5");
const syncN = Number(args.sync ?? 20);
const streamN = Number(args.stream ?? 10);
const warmupMs = Number(args["warmup-ms"] ?? 3000);
const apiKey = args.key ?? process.env.CURSOR_BRIDGE_API_KEY ?? "";

function authHeaders(extra = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    min: s[0],
    max: s[s.length - 1],
  };
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(1) : "-";
}

async function getStatus() {
  const res = await fetch(`${target}/api/status`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET /api/status ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function syncOnce(i) {
  const t0 = performance.now();
  const res = await fetch(`${target}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 16,
      messages: [{ role: "user", content: `ping ${i}: reply with ok only` }],
    }),
  });
  const text = await res.text();
  const totalMs = performance.now() - t0;
  const hit = res.headers.get("x-cursor-proxy-pool-hit");
  const miss = res.headers.get("x-cursor-proxy-pool-miss-reason");
  let ok = res.ok;
  let preview = text.slice(0, 80).replace(/\s+/g, " ");
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
  return {
    ok,
    status: res.status,
    totalMs,
    poolHit: hit === "1",
    poolMiss: hit === "0",
    missReason: miss ?? undefined,
    headerPresent: hit != null,
    preview,
  };
}

async function streamOnce(i) {
  const t0 = performance.now();
  const res = await fetch(`${target}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: `stream ping ${i}: reply ok` }],
    }),
  });
  const text = await res.text();
  const totalMs = performance.now() - t0;
  const ok = res.ok && !text.includes('"code":"cold_spawn_capacity"');
  return { ok, status: res.status, totalMs, bytes: text.length };
}

function printStatusSnapshot(label, status) {
  const pool = status.pool ?? {};
  const metrics = pool.metrics ?? {};
  console.log(`\n=== ${label} ===`);
  console.log(
    `pool.enabled=${pool.enabled ?? "?"} eligible=${metrics.eligible ?? 0} hits=${metrics.hits ?? 0} coldSpawns=${metrics.coldSpawns ?? 0}`,
  );
  if (metrics.misses && Object.keys(metrics.misses).length) {
    console.log(`misses=${JSON.stringify(metrics.misses)}`);
  }
  if (pool.inventory) {
    console.log(`inventory=${JSON.stringify(pool.inventory)}`);
  }
  if (Array.isArray(status.accounts)) {
    console.log(
      `accounts=${status.accounts.length} usable=${status.accounts.filter((a) => !a.isDisabled).length}`,
    );
  }
}

async function main() {
  console.log(
    `verify-pool-hit target=${target} model=${model} sync=${syncN} stream=${streamN}`,
  );

  const before = await getStatus();
  printStatusSnapshot("status (before)", before);
  if (before.pool && before.pool.enabled === false) {
    console.warn(
      "WARN: session pool disabled on server — expect pool_hit headers absent / hit rate 0",
    );
  }

  if (warmupMs > 0) {
    console.log(`\nwarmup sleep ${warmupMs}ms…`);
    await new Promise((r) => setTimeout(r, warmupMs));
  }

  console.log("\n=== sync ===");
  const syncResults = [];
  for (let i = 1; i <= syncN; i++) {
    try {
      const r = await syncOnce(i);
      syncResults.push(r);
      const tag = !r.headerPresent
        ? "no-header"
        : r.poolHit
          ? "HIT"
          : `MISS${r.missReason ? `(${r.missReason})` : ""}`;
      console.log(
        `[sync ${i}/${syncN}] ${r.ok ? "ok" : "FAIL"} ${fmt(r.totalMs)}ms ${tag} :: ${r.preview}`,
      );
    } catch (err) {
      console.log(`[sync ${i}/${syncN}] ERROR ${err?.message ?? err}`);
      syncResults.push({ ok: false, totalMs: NaN, headerPresent: false });
    }
  }

  const syncOk = syncResults.filter((r) => r.ok && Number.isFinite(r.totalMs));
  const withHeader = syncOk.filter((r) => r.headerPresent);
  const hits = withHeader.filter((r) => r.poolHit).length;
  const hitRate = withHeader.length ? hits / withHeader.length : NaN;
  const syncLat = summarize(syncOk.map((r) => r.totalMs));

  console.log("\n=== stream ===");
  const metricsBeforeStream = (await getStatus()).pool?.metrics ?? {};
  const streamResults = [];
  for (let i = 1; i <= streamN; i++) {
    try {
      const r = await streamOnce(i);
      streamResults.push(r);
      console.log(
        `[stream ${i}/${streamN}] ${r.ok ? "ok" : "FAIL"} ${fmt(r.totalMs)}ms bytes=${r.bytes}`,
      );
    } catch (err) {
      console.log(`[stream ${i}/${streamN}] ERROR ${err?.message ?? err}`);
      streamResults.push({ ok: false, totalMs: NaN });
    }
  }
  const metricsAfterStream = (await getStatus()).pool?.metrics ?? {};
  const streamEligible =
    (metricsAfterStream.eligible ?? 0) - (metricsBeforeStream.eligible ?? 0);
  const streamHits =
    (metricsAfterStream.hits ?? 0) - (metricsBeforeStream.hits ?? 0);
  const streamHitRate =
    streamEligible > 0 ? streamHits / streamEligible : NaN;
  const streamOk = streamResults.filter(
    (r) => r.ok && Number.isFinite(r.totalMs),
  );
  const streamLat = summarize(streamOk.map((r) => r.totalMs));

  const after = await getStatus();
  printStatusSnapshot("status (after)", after);

  console.log("\n=== summary ===");
  console.log(
    `sync: ok=${syncOk.length}/${syncN} header=${withHeader.length} hits=${hits} hit_rate=${Number.isFinite(hitRate) ? (hitRate * 100).toFixed(1) + "%" : "-"} latency_p50=${fmt(syncLat.p50)}ms p95=${fmt(syncLat.p95)}ms`,
  );
  console.log(
    `stream: ok=${streamOk.length}/${streamN} eligibleΔ=${streamEligible} hitsΔ=${streamHits} hit_rate=${Number.isFinite(streamHitRate) ? (streamHitRate * 100).toFixed(1) + "%" : "-"} latency_p50=${fmt(streamLat.p50)}ms p95=${fmt(streamLat.p95)}ms`,
  );

  const gate =
    Number.isFinite(hitRate) && withHeader.length >= Math.min(5, syncN)
      ? hitRate >= 0.95
        ? "PASS (≥95% sync header hit rate)"
        : "FAIL (<95% sync header hit rate)"
      : "SKIP (not enough headed samples — warm pool / enable SESSION_POOL)";
  console.log(`\nGate: ${gate}`);
  if (!Number.isFinite(hitRate) || withHeader.length < Math.min(5, syncN)) {
    process.exitCode = 2;
  } else if (hitRate < 0.95) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
