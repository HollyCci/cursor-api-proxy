import path from "node:path";
import {
  reportAccountDisabled,
  getAccountStats,
  getUsableCount,
} from "./account-pool.js";
import { getSessionPool, poolAccountKey } from "./acp-session-pool.js";

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
