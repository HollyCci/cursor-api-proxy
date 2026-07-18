import { describe, expect, it } from "vitest";

import { resolveModelForExecution, resolveToCursorModel } from "./model-map.js";

describe("resolveToCursorModel", () => {
  it("maps dated sonnet id to cursor sonnet-4.5", () => {
    expect(resolveToCursorModel("claude-sonnet-4-5-20250929")).toBe("sonnet-4.5");
  });

  it("maps dated opus id with v-suffix", () => {
    expect(resolveToCursorModel("claude-opus-4-6-20260101-v1")).toBe("opus-4.6");
  });

  it("maps dated haiku id to sonnet fallback", () => {
    expect(resolveToCursorModel("claude-haiku-4-5-20251001")).toBe("sonnet-4.5");
  });
});

describe("resolveModelForExecution", () => {
  it("uses mapped model when available", () => {
    const decision = resolveModelForExecution({
      requested: "claude-sonnet-4-5-20250929",
      defaultModel: "auto",
      availableCursorIds: ["auto", "sonnet-4.5"],
    });
    expect(decision.final).toBe("sonnet-4.5");
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.validated).toBe(true);
    expect(decision.ok).toBe(true);
  });

  it("falls back to default model when mapped model is unavailable", () => {
    const decision = resolveModelForExecution({
      requested: "claude-sonnet-4-5-20250929",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.2"],
    });
    expect(decision.final).toBe("auto");
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.fallbackReason).toBe("mapped_model_unavailable");
    expect(decision.ok).toBe(true);
  });

  it("prefers explicit default request", () => {
    const decision = resolveModelForExecution({
      requested: "default",
      defaultModel: "auto",
      availableCursorIds: ["auto"],
    });
    expect(decision.final).toBe("default");
    expect(decision.requestedWasDefault).toBe(true);
    expect(decision.ok).toBe(true);
  });

  it("fast lane fails closed when target missing from catalog", () => {
    const decision = resolveModelForExecution({
      requested: "composer-2.5",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.2"],
      lane: "fast",
    });
    expect(decision.ok).toBe(false);
    expect(decision.error).toBe("cursor_fast_unavailable");
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.final).toBe("composer-2.5");
  });

  it("fast lane fails closed on empty catalog", () => {
    const decision = resolveModelForExecution({
      requested: "composer-2.5",
      defaultModel: "auto",
      availableCursorIds: [],
      lane: "fast",
    });
    expect(decision.ok).toBe(false);
    expect(decision.error).toBe("cursor_fast_unavailable");
  });

  it("fast lane succeeds on exact catalog match", () => {
    const decision = resolveModelForExecution({
      requested: "composer-2.5",
      defaultModel: "auto",
      availableCursorIds: ["auto", "composer-2.5"],
      lane: "fast",
    });
    expect(decision.ok).toBe(true);
    expect(decision.final).toBe("composer-2.5");
    expect(decision.fallbackUsed).toBe(false);
  });
});
