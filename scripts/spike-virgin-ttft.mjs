#!/usr/bin/env node
/**
 * Phase 2 Step A — virgin first-prompt TTFT + attribution timeline
 * Fable: n=30 fresh with per-request ACP event timeline for >8s samples.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const freshN = Number(args.freshN ?? 30);
const agentBin = String(args.agent ?? process.env.CURSOR_AGENT_BIN ?? "agent");
const cwd = String(
  args.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-virgin-")),
);
const slowMs = Number(args.slowMs ?? 8000);
const outDir = String(
  args.outDir ?? path.join(cwd, "timelines"),
);

fs.mkdirSync(outDir, { recursive: true });

function pct(arr, p) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function createClient(child) {
  const pending = new Map();
  let nextId = 1;
  /** @type {((ev: object) => void) | null} */
  let onEvent = null;
  const rl = readline.createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    const t = line.replace(/\r$/, "").trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      onEvent?.({ t: performance.now(), kind: "parse_error", raw: t.slice(0, 200) });
      return;
    }
    const now = performance.now();
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(Number(msg.id));
      onEvent?.({
        t: now,
        kind: "rpc_response",
        id: msg.id,
        method: waiter?.method,
        error: msg.error?.message,
        hasResult: msg.result !== undefined,
      });
      if (!waiter) return;
      pending.delete(Number(msg.id));
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "ACP error"));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const update = msg.params?.update ?? msg.params;
      const sid = msg.params?.sessionId ?? update?.sessionId;
      const su = update?.sessionUpdate ?? update?.sessionUpdate;
      const content = update?.content;
      let text = "";
      if (content && typeof content === "object" && !Array.isArray(content)) {
        text = content.text ?? "";
      } else if (Array.isArray(content)) {
        text = content.map((c) => c?.content?.text ?? c?.text ?? "").join("");
      }
      onEvent?.({
        t: now,
        kind: "session_update",
        sessionId: sid,
        sessionUpdate: su,
        textLen: text.length,
        textPreview: text.slice(0, 40),
      });
    } else if (msg.method) {
      onEvent?.({
        t: now,
        kind: "server_request",
        method: msg.method,
        id: msg.id,
      });
    }
    if (msg.method && msg.id != null && child.stdin) {
      if (msg.method === "session/request_permission") {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId: "allow-once" } },
          }) + "\n",
        );
      } else if (String(msg.method).startsWith("cursor/")) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n",
        );
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    const tSend = performance.now();
    onEvent?.({ t: tSend, kind: "rpc_send", id, method });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        onEvent?.({ t: performance.now(), kind: "rpc_timeout", id, method });
        reject(new Error(`timeout ${method}`));
      }, 180_000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  return {
    request,
    setOnEvent(fn) {
      onEvent = fn;
    },
  };
}

async function main() {
  console.log(
    `spike-virgin-ttft ATTR freshN=${freshN} slowMs=${slowMs} outDir=${outDir}`,
  );

  const child = spawn(agentBin, ["acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let stderrBuf = "";
  const stderrMarks = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    const t = performance.now();
    stderrBuf += c;
    stderrMarks.push({ t, chunk: c.slice(0, 500) });
  });
  child.on("error", (err) => {
    console.error("spawn error", err);
    process.exit(1);
  });

  const client = createClient(child);
  const bootEvents = [];
  client.setOnEvent((ev) => bootEvents.push(ev));
  const tBoot = performance.now();
  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "spike-virgin-ttft", version: "0.2.0" },
  });
  console.log(`boot initialize ${(performance.now() - tBoot).toFixed(1)}ms`);

  const rows = [];

  for (let i = 1; i <= freshN; i++) {
    const timeline = [];
    const stderrAtStart = stderrMarks.length;
    client.setOnEvent((ev) => timeline.push(ev));

    const tNew0 = performance.now();
    const session = await client.request("session/new", { cwd, mcpServers: [] });
    const sessionId = session?.sessionId;
    if (!sessionId) throw new Error("no sessionId");
    const newMs = performance.now() - tNew0;

    let firstByteAt = null;
    let firstByteEvent = null;
    const tPrompt0 = performance.now();
    timeline.push({ t: tPrompt0, kind: "prompt_mark_start", sessionId });

    // wrap setOnEvent to also capture first byte
    const prev = timeline;
    client.setOnEvent((ev) => {
      prev.push(ev);
      if (
        firstByteAt == null &&
        ev.kind === "session_update" &&
        (ev.textLen ?? 0) > 0
      ) {
        firstByteAt = ev.t;
        firstByteEvent = ev;
      }
    });

    let err = null;
    try {
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: `只回ok fresh-${i}` }],
      });
    } catch (e) {
      err = e.message ?? String(e);
    }
    const tPromptDone = performance.now();
    const ttftMs = firstByteAt != null ? firstByteAt - tPrompt0 : NaN;
    const totalMs = tPromptDone - tPrompt0;

    const stderrDuring = stderrMarks
      .slice(stderrAtStart)
      .map((m) => ({
        offsetMs: m.t - tPrompt0,
        chunk: m.chunk.replace(/\s+/g, " ").slice(0, 200),
      }));

    // Heuristic attribution tags
    const tags = [];
    if (!Number.isFinite(ttftMs)) tags.push("no_first_byte");
    if (ttftMs > slowMs) {
      const gapAfterSend = firstByteAt != null
        ? firstByteAt -
          (timeline.find((e) => e.kind === "rpc_send" && e.method === "session/prompt")
            ?.t ?? tPrompt0)
        : NaN;
      const updatesBeforeFirst = timeline.filter(
        (e) =>
          e.kind === "session_update" &&
          firstByteAt != null &&
          e.t <= firstByteAt,
      ).length;
      const timeouts = timeline.filter((e) => e.kind === "rpc_timeout").length;
      const errors = timeline.filter((e) => e.error).length;
      if (timeouts) tags.push("rpc_timeout");
      if (errors) tags.push("rpc_error");
      if (stderrDuring.length) tags.push("stderr_during_prompt");
      if (gapAfterSend > 8000 && updatesBeforeFirst <= 1) {
        tags.push("long_silence_after_prompt_send_likely_upstream");
      }
      if (newMs > 5000) tags.push("slow_session_new");
      if (!tags.length) tags.push("unattributed_slow");
    }

    const row = {
      i,
      warmup: i === 1,
      sessionId,
      newMs,
      ttftMs,
      totalMs,
      err,
      tags,
      firstBytePreview: firstByteEvent?.textPreview,
    };
    rows.push(row);

    const file = path.join(outDir, `fresh-${String(i).padStart(2, "0")}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          row,
          timeline: timeline.map((e) => ({
            ...e,
            offsetMs: e.t - tPrompt0,
          })),
          stderrDuring,
        },
        null,
        2,
      ),
    );

    console.log(
      `[fresh ${i}/${freshN}] new=${newMs.toFixed(0)} TTFT=${Number.isFinite(ttftMs) ? ttftMs.toFixed(1) : "-"} total=${totalMs.toFixed(1)}${ttftMs > slowMs ? " SLOW" : ""}${err ? ` ERR=${err}` : ""} tags=${tags.join(",") || "-"}`,
    );

    try {
      await client.request("session/cancel", { sessionId });
    } catch {
      /* optional */
    }
    client.setOnEvent(null);
  }

  const rest = rows.filter((r) => !r.warmup && r.ok !== false && Number.isFinite(r.ttftMs));
  // all non-warmup with finite ttft
  const statsRows = rows.filter((r) => !r.warmup && Number.isFinite(r.ttftMs));
  const ttfts = statsRows.map((r) => r.ttftMs);
  const slow = rows.filter((r) => Number.isFinite(r.ttftMs) && r.ttftMs > slowMs);

  console.log("\n=== stats (excl process warmup #1) ===");
  console.log(
    `n=${ttfts.length} p50=${pct(ttfts, 50).toFixed(1)} p95=${pct(ttfts, 95).toFixed(1)} max=${Math.max(...ttfts).toFixed(1)}`,
  );
  console.log(
    `>8s count=${slow.filter((r) => !r.warmup).length}/${ttfts.length} rate=${((slow.filter((r) => !r.warmup).length / ttfts.length) * 100).toFixed(1)}%`,
  );

  console.log("\n=== >8s attribution table ===");
  if (!slow.length) console.log("(none)");
  for (const r of slow.sort((a, b) => b.ttftMs - a.ttftMs)) {
    console.log(
      `#${r.i} TTFT=${r.ttftMs.toFixed(1)} new=${r.newMs.toFixed(0)} warmup=${r.warmup} tags=${r.tags.join("|")} session=${r.sessionId}`,
    );
  }

  const top2 = [...slow].sort((a, b) => b.ttftMs - a.ttftMs).slice(0, 2);
  console.log("\n=== top2 timeline files ===");
  for (const r of top2) {
    console.log(
      path.join(outDir, `fresh-${String(r.i).padStart(2, "0")}.json`),
    );
  }

  const summaryPath = path.join(outDir, "summary.json");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        freshN,
        statsExclWarmup: {
          n: ttfts.length,
          p50: pct(ttfts, 50),
          p95: pct(ttfts, 95),
          max: Math.max(...ttfts),
          gt8rate:
            slow.filter((r) => !r.warmup).length / Math.max(1, ttfts.length),
        },
        slow,
        top2Files: top2.map((r) =>
          path.join(outDir, `fresh-${String(r.i).padStart(2, "0")}.json`),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`\nsummary=${summaryPath}`);

  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  child.kill("SIGTERM");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
