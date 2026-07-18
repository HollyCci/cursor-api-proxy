import { describe, it, expect } from "vitest";
import {
  classifyAccountFailure,
  shouldDisableForPlanUpgrade,
} from "./account-failure.js";

describe("classifyAccountFailure", () => {
  it("detects upgrade your plan before rate limit", () => {
    expect(
      classifyAccountFailure("Upgrade your plan to continue\n429 rate limit"),
    ).toBe("plan_upgrade");
  });

  it("detects rate limit", () => {
    expect(classifyAccountFailure("Error 429 too many requests")).toBe(
      "rate_limit",
    );
  });

  it("does not treat bare plan to continue as upgrade", () => {
    expect(classifyAccountFailure("Please plan to continue tomorrow")).toBe(
      "other",
    );
  });
});

describe("shouldDisableForPlanUpgrade", () => {
  it("disables short error-channel upgrade text", () => {
    expect(
      shouldDisableForPlanUpgrade({
        text: "Upgrade your plan to continue",
        fromErrorChannel: true,
      }),
    ).toBe(true);
  });

  it("disables short stdout that is almost only the upgrade sentence", () => {
    expect(
      shouldDisableForPlanUpgrade({
        text: "Upgrade your plan to continue",
        exitCode: 0,
        fromErrorChannel: false,
      }),
    ).toBe(true);
  });

  it("does not disable long success text that mentions upgrade", () => {
    const long = `${"x".repeat(400)} Upgrade your plan to continue ${"y".repeat(400)}`;
    expect(
      shouldDisableForPlanUpgrade({
        text: long,
        exitCode: 0,
        fromErrorChannel: false,
      }),
    ).toBe(false);
  });
});
