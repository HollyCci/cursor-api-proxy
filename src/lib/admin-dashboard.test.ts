import { describe, it, expect } from "vitest";
import {
  buildAccountCapacityView,
  buildPoolStatusView,
} from "./admin-dashboard.js";
import type { AccountStat } from "./account-pool.js";

function stat(partial: Partial<AccountStat> & { configDir: string }): AccountStat {
  return {
    activeRequests: 0,
    totalRequests: 0,
    totalSuccess: 0,
    totalErrors: 0,
    totalRateLimits: 0,
    totalLatencyMs: 0,
    isRateLimited: false,
    rateLimitUntil: 0,
    isDisabled: false,
    disabledReason: "",
    disabledAt: 0,
    ...partial,
  };
}

describe("buildAccountCapacityView", () => {
  it("uses basename for configDir and filters current rate limits", () => {
    const now = 1_000_000;
    const view = buildAccountCapacityView(
      [
        stat({
          configDir: "/tmp/accounts/acc-a",
          isDisabled: true,
          disabledReason: "upgrade_plan",
          disabledAt: 500,
        }),
        stat({
          configDir: "/tmp/accounts/acc-b",
          rateLimitUntil: now + 60_000,
          isRateLimited: true,
        }),
        stat({
          configDir: "/tmp/accounts/acc-c",
          rateLimitUntil: now - 1,
          isRateLimited: false,
        }),
      ],
      2,
      now,
    );

    expect(view).toEqual({
      total: 3,
      usable: 2,
      disabled: [
        {
          configDir: "acc-a",
          reason: "upgrade_plan",
          disabledAt: 500,
        },
      ],
      rateLimited: [{ configDir: "acc-b", until: now + 60_000 }],
    });
  });
});

describe("buildPoolStatusView", () => {
  it("exposes enabled, metrics, and inventory for /api/status.pool", () => {
    const view = buildPoolStatusView(
      true,
      {
        eligible: 2,
        hits: 1,
        misses: { empty: 1 },
        coldSpawns: 1,
      },
      {
        acc1: { pooled: 1, warming: 0, checkedOut: 0 },
      },
    );
    expect(view).toEqual({
      enabled: true,
      metrics: {
        eligible: 2,
        hits: 1,
        misses: { empty: 1 },
        coldSpawns: 1,
      },
      inventory: {
        acc1: { pooled: 1, warming: 0, checkedOut: 0 },
      },
    });
  });
});

