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

/**
 * True when the text is essentially only the plan-upgrade notice
 * (not a long reply that merely mentions billing).
 */
export function looksLikePlanUpgradeOnlyResponse(text: string): boolean {
  const t = text.trim();
  if (!t || !PLAN_UPGRADE_RE.test(t)) return false;
  const stripped = t
    .replace(/upgrade your plan(?: to continue)?/gi, "")
    .replace(/[.!?,;:\s"'`\-–—]+/g, "")
    .trim();
  return stripped.length === 0;
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
  return looksLikePlanUpgradeOnlyResponse(text);
}
