import { describe, it, expect, beforeEach, vi } from "vitest";
import { initAccountPool, getUsableCount, getAccountStats } from "./account-pool.js";
import { quarantineAccount } from "./account-quarantine.js";

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
