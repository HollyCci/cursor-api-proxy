import * as fs from "node:fs";
import * as path from "node:path";

import { getSessionPool } from "./acp-session-pool.js";
import type { BridgeConfig } from "./config.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

function agentBinExists(agentBin: string): boolean {
  if (path.isAbsolute(agentBin) || agentBin.includes(path.sep)) {
    return fs.existsSync(agentBin);
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, agentBin))) return true;
    if (
      process.platform === "win32" &&
      (fs.existsSync(path.join(dir, `${agentBin}.cmd`)) ||
        fs.existsSync(path.join(dir, `${agentBin}.exe`)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Lightweight preflight checks for gateway / pool readiness.
 * Does not start the HTTP server or warm ACP sessions.
 */
export function runDoctor(config: BridgeConfig): DoctorResult {
  const checks: DoctorCheck[] = [];

  const binOk = agentBinExists(config.agentBin);
  checks.push({
    name: "agentBin",
    ok: binOk,
    detail: binOk
      ? `found: ${config.agentBin}`
      : `not found on PATH or filesystem: ${config.agentBin}`,
  });

  checks.push({
    name: "useAcp",
    ok: config.useAcp,
    detail: config.useAcp
      ? "ACP enabled"
      : "ACP disabled (CURSOR_BRIDGE_USE_ACP)",
  });

  const modelOk = Boolean(config.defaultModel?.trim());
  checks.push({
    name: "defaultModel",
    ok: modelOk,
    detail: modelOk
      ? `defaultModel=${config.defaultModel}`
      : "defaultModel is empty",
  });

  const poolOk = !config.useAcp || config.sessionPool;
  checks.push({
    name: "sessionPool",
    ok: poolOk,
    detail: config.sessionPool
      ? `enabled (minIdle=${config.sessionPoolMinIdle}, maxSessions=${config.sessionPoolMaxSessions})`
      : config.useAcp
        ? "disabled while ACP is on (set CURSOR_BRIDGE_SESSION_POOL=true for pool hits)"
        : "disabled",
  });

  if (config.configDirs.length === 0) {
    checks.push({
      name: "accountDirs",
      ok: true,
      detail: "no configDirs (single default account)",
    });
  } else {
    for (const dir of config.configDirs) {
      const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      checks.push({
        name: `accountDir:${path.basename(dir)}`,
        ok: exists,
        detail: exists ? dir : `missing: ${dir}`,
      });
    }
  }

  if (config.sessionPool) {
    const pool = getSessionPool();
    if (pool?.enabled) {
      const stats = pool.stats();
      const keys = Object.keys(stats);
      checks.push({
        name: "poolStats",
        ok: true,
        detail:
          keys.length === 0
            ? "pool enabled (no inventory yet)"
            : keys
                .map((k) => {
                  const s = stats[k]!;
                  return `${k}: pooled=${s.pooled} warming=${s.warming} checkedOut=${s.checkedOut}`;
                })
                .join("; "),
      });
    } else {
      checks.push({
        name: "poolStats",
        ok: true,
        detail: "pool enabled in config (not running; start server for live stats)",
      });
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}
