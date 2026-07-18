import { describe, expect, it } from "vitest";

import { agentResultFromPoolPromptError } from "./agent-runner.js";

describe("agentResultFromPoolPromptError", () => {
  it("returns failed AgentRunResult for plan-upgrade error channel text", () => {
    const err = new Error("Upgrade your plan to continue");
    expect(agentResultFromPoolPromptError(err)).toEqual({
      code: 1,
      stdout: "",
      stderr: "Upgrade your plan to continue",
      failureText: "Upgrade your plan to continue",
      poolHit: true,
    });
  });

  it("returns null for ordinary errors so cold fallback can proceed", () => {
    expect(agentResultFromPoolPromptError(new Error("connection reset"))).toBeNull();
  });
});
