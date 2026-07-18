export type AccountFailureKind = "plan_upgrade" | "rate_limit" | "other";

const PLAN_UPGRADE_RE = /upgrade your plan/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;

export function classifyAccountFailure(
  text: string | undefined | null,
): AccountFailureKind {
  if (!text) return "other";
  if (PLAN_UPGRADE_RE.test(text)) return "plan_upgrade";
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  return "other";
}

/** False-positive guard: long success bodies that merely mention billing. */
export function shouldDisableForPlanUpgrade(opts: {
  text: string;
  exitCode?: number;
  fromErrorChannel?: boolean;
}): boolean {
  const text = opts.text.trim();
  if (!text || !PLAN_UPGRADE_RE.test(text)) return false;
  if (opts.fromErrorChannel) return true;
  if (typeof opts.exitCode === "number" && opts.exitCode !== 0) return true;
  // Short assistant/stdout that is essentially the upgrade message.
  return text.length <= 120;
}
