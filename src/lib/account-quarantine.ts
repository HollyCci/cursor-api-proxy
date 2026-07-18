import path from "node:path";
import {
  reportAccountDisabled,
  reportRateLimit,
  getAccountStats,
  getUsableCount,
} from "./account-pool.js";
import { getSessionPool, poolAccountKey } from "./acp-session-pool.js";
import {
  classifyAccountFailure,
  shouldDisableForPlanUpgrade,
  type AccountFailureKind,
} from "./account-failure.js";

export const NO_USABLE_ACCOUNTS_ERROR = {
  message: "No usable Cursor accounts (all disabled)",
  code: "no_usable_accounts",
} as const;

/** True when multi-account pool exists but every account is disabled. */
export function isAllAccountsDisabled(
  configDir: string | undefined,
): boolean {
  return (
    configDir === undefined &&
    getAccountStats().length > 0 &&
    getUsableCount() === 0
  );
}

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

export function applyAgentAccountSignals(
  configDir: string | undefined,
  result: {
    code: number;
    stdout?: string;
    stderr?: string;
    failureText?: string;
  },
): AccountFailureKind {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const errText = [stderr, result.failureText].filter(Boolean).join("\n");
  if (
    shouldDisableForPlanUpgrade({
      text: errText,
      exitCode: result.code,
      fromErrorChannel: true,
    }) ||
    shouldDisableForPlanUpgrade({
      text: stdout,
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
