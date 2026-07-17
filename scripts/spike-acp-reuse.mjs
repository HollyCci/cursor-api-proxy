#!/usr/bin/env node
/**
 * Phase 0.5 — ACP process reuse spike.
 *
 * Keeps ONE `agent acp` process alive; for each of N prompts:
 *   session/new → (optional set model) → session/prompt
 *
 * Usage:
 *   node scripts/spike-acp-reuse.mjs [--n=10] [--model=auto] [--cwd=/tmp] [--agent=agent]
 *   node scripts/spike-acp-reuse.mjs --mode=sticky     # one session, N prompts
 *   node scripts/spike-acp-reuse.mjs --mode=new        # default: session/new per prompt
 *
 * Gate (plan): prompts 2..N p50 ≤ 2s → allow Phase 2 (tier A)
 *              prompts 2..N p50 ≤ 700ms → allow stretch to 1s (tier S)
 *
 * Empirically (2026-07-17 local): sticky warm p50 ~0.4s; new-session warm p50 ~2.7–4s
 * (session/new dominates). Phase 2 must pool pre-warmed sessions, not only processes.
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

const n = Number(args.n ?? 10);
const mode = String(args.mode ?? "new"); // new | sticky
const model = args.model ? String(args.model) : undefined;
const agentBin = String(args.agent ?? process.env.CURSOR_AGENT_BIN ?? "agent");
const cwd = String(
  args.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-spike-")),
);
const requestTimeoutMs = Number(args.timeout ?? 120_000);
const skipAuth = /^(1|true|yes)$/i.test(
  String(args.skipAuth ?? process.env.CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE ?? ""),
);

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function send(stdin, id, method, params) {
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", "utf8");
}

function createClient(child) {
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    const t = line.replace(/\r$/, "").trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(Number(msg.id));
      if (!waiter) return;
      pending.delete(Number(msg.id));
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "ACP error"));
      else waiter.resolve(msg.result);
      return;
    }

    // Auto-respond to common server→client requests
    if (msg.method && msg.id != null && child.stdin) {
      if (msg.method === "session/request_permission") {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId: "allow-once" } },
          }) + "\n",
        );
        return;
      }
      if (String(msg.method).startsWith("cursor/")) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n",
        );
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(child.stdin, id, method, params);
    });
  }

  return { request, pending };
}

async function main() {
  if (mode !== "new" && mode !== "sticky") {
    console.error(`unknown --mode=${mode} (use new|sticky)`);
    process.exit(1);
  }
  console.log(
    `spike-acp-reuse mode=${mode} n=${n} agent=${agentBin} cwd=${cwd} model=${model ?? "(default)"} skipAuth=${skipAuth}`,
  );

  const child = spawn(agentBin, ["acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderr += c;
  });

  const exitPromise = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  child.on("error", (err) => {
    console.error("spawn error:", err.message);
    process.exit(1);
  });

  const { request } = createClient(child);

  const tBoot0 = performance.now();
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "spike-acp-reuse", version: "0.1.0" },
  });
  if (!skipAuth) {
    try {
      await request("authenticate", { methodId: "cursor_login" });
    } catch (err) {
      console.warn("authenticate failed (continuing):", err.message);
    }
  }
  const bootMs = performance.now() - tBoot0;
  console.log(`boot initialize(+auth) ${bootMs.toFixed(1)}ms`);

  const runs = [];
  let stickySessionId;

  if (mode === "sticky") {
    const session = await request("session/new", { cwd, mcpServers: [] });
    stickySessionId = session?.sessionId;
    if (!stickySessionId) throw new Error("no sessionId for sticky mode");
    if (model) {
      try {
        await request("session/set_config_option", {
          sessionId: stickySessionId,
          configId: "model",
          value: model,
        });
      } catch {
        /* optional */
      }
    }
    console.log(`sticky sessionId=${stickySessionId}`);
  }

  for (let i = 1; i <= n; i++) {
    const prompt = i === 1 ? "只回ok" : `只回ok #${i}`;
    const t0 = performance.now();
    let sessionMs = 0;
    let promptMs = 0;
    let err = null;
    try {
      let sessionId = stickySessionId;
      if (mode === "new") {
        const tS0 = performance.now();
        const session = await request("session/new", { cwd, mcpServers: [] });
        sessionId = session?.sessionId;
        if (!sessionId) throw new Error("no sessionId");
        if (model) {
          try {
            await request("session/set_config_option", {
              sessionId,
              configId: "model",
              value: model,
            });
          } catch {
            /* model optional */
          }
        }
        sessionMs = performance.now() - tS0;
      }

      const tP0 = performance.now();
      await request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      promptMs = performance.now() - tP0;
    } catch (e) {
      err = e.message ?? String(e);
    }
    const totalMs = performance.now() - t0;
    runs.push({ i, totalMs, sessionMs, promptMs, err });
    console.log(
      `[${i}/${n}] total=${totalMs.toFixed(1)}ms session/new=${sessionMs.toFixed(1)}ms prompt=${promptMs.toFixed(1)}ms${err ? ` ERR=${err}` : ""}`,
    );
  }

  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  child.kill("SIGTERM");
  const code = await Promise.race([
    exitPromise,
    new Promise((r) => setTimeout(() => r(-1), 2000)),
  ]);
  if (code === -1) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  const okRuns = runs.filter((r) => !r.err);
  const warm = okRuns.filter((r) => r.i >= 2).map((r) => r.totalMs);
  const warmSorted = [...warm].sort((a, b) => a - b);
  const p50 = percentile(warmSorted, 50);
  const p95 = percentile(warmSorted, 95);
  const first = runs[0];

  console.log("\n=== Spike summary ===");
  console.log(`boot=${bootMs.toFixed(1)}ms first_prompt=${first?.totalMs?.toFixed(1) ?? "-"}ms`);
  console.log(
    `warm(2..${n}) n=${warm.length} p50=${Number.isFinite(p50) ? p50.toFixed(1) : "-"}ms p95=${Number.isFinite(p95) ? p95.toFixed(1) : "-"}ms`,
  );
  if (stderr.trim()) {
    console.log(`stderr_tail: ${stderr.trim().slice(-400)}`);
  }

  console.log("\n=== Gate 0.5 ===");
  if (!Number.isFinite(p50) || warm.length === 0) {
    console.log("FAIL — no successful warm prompts; Phase 2 blocked");
    process.exit(2);
  } else if (p50 <= 700) {
    console.log(`PASS stretch — warm p50=${p50.toFixed(1)}ms ≤700ms → may pursue Gate 2b (1s)`);
  } else if (p50 <= 2000) {
    console.log(`PASS tier A — warm p50=${p50.toFixed(1)}ms ≤2s → allow Phase 2 (target 3s)`);
  } else {
    console.log(`FAIL — warm p50=${p50.toFixed(1)}ms >2s → do not build pool as-is`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
