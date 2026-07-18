import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initAccountPool,
  getUsableCount,
  getAccountStats,
  getNextAccountConfigDir,
} from "./account-pool.js";
import {
  quarantineAccount,
  applyAgentAccountSignals,
  isAllAccountsDisabled,
} from "./account-quarantine.js";

describe("quarantineAccount", () => {
  beforeEach(() => {
    initAccountPool(["/tmp/acc-a", "/tmp/acc-b"]);
  });

  it("disables account in AccountPool", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    quarantineAccount("/tmp/acc-a", "upgrade_plan");
    expect(getUsableCount()).toBe(1);
    expect(
      getAccountStats().find((s) => s.configDir === "/tmp/acc-a")?.isDisabled,
    ).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("applyAgentAccountSignals", () => {
  beforeEach(() => {
    initAccountPool(["/tmp/acc-a", "/tmp/acc-b"]);
  });

  it("quarantines on plan upgrade stderr", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kind = applyAgentAccountSignals("/tmp/acc-a", {
      code: 1,
      stdout: "",
      stderr: "Upgrade your plan to continue",
    });
    expect(kind).toBe("plan_upgrade");
    expect(getUsableCount()).toBe(1);
    expect(
      getAccountStats().find((s) => s.configDir === "/tmp/acc-a")?.isDisabled,
    ).toBe(true);
    spy.mockRestore();
  });

  it("reports rate limit without disabling", () => {
    const kind = applyAgentAccountSignals("/tmp/acc-a", {
      code: 1,
      stdout: "",
      stderr: "Error 429 too many requests",
    });
    expect(kind).toBe("rate_limit");
    expect(getUsableCount()).toBe(2);
    expect(
      getAccountStats().find((s) => s.configDir === "/tmp/acc-a")?.isDisabled,
    ).toBe(false);
  });

  it("does not quarantine long success when failureText wrongly mirrors stdout", () => {
    const long = `${"x".repeat(400)} Upgrade your plan to continue ${"y".repeat(400)}`;
    const kind = applyAgentAccountSignals("/tmp/acc-a", {
      code: 0,
      stdout: long,
      stderr: "",
      failureText: long,
    });
    expect(kind).toBe("other");
    expect(getUsableCount()).toBe(2);
  });

  it("quarantines short upgrade-only stdout on success", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kind = applyAgentAccountSignals("/tmp/acc-a", {
      code: 0,
      stdout: "Upgrade your plan to continue",
      stderr: "",
    });
    expect(kind).toBe("plan_upgrade");
    expect(getUsableCount()).toBe(1);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/disabledAt=\d+/);
    spy.mockRestore();
  });
});

describe("isAllAccountsDisabled", () => {
  beforeEach(() => {
    initAccountPool(["/tmp/acc-a", "/tmp/acc-b"]);
  });

  it("is true when getNext is undefined because all disabled", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    quarantineAccount("/tmp/acc-a", "upgrade_plan");
    quarantineAccount("/tmp/acc-b", "upgrade_plan");
    const next = getNextAccountConfigDir();
    expect(next).toBeUndefined();
    expect(isAllAccountsDisabled(next)).toBe(true);
    spy.mockRestore();
  });

  it("is false for empty pool / single-default mode", () => {
    initAccountPool([]);
    expect(isAllAccountsDisabled(undefined)).toBe(false);
  });
});
