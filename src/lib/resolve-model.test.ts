import { describe, expect, it } from "vitest";

import { rememberResolvedModel, resolveModel } from "./resolve-model.js";
import type { BridgeConfig } from "./config.js";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "auto",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    stickyModel: false,
    cursorFastModel: "composer-2.5",
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    toolCalls: false,
    thoughtMode: "drop",
    sessionPool: false,
    sessionPoolMinIdle: 1,
    sessionPoolMaxSessions: 2,
    sessionPoolIdleTtlMs: 900000,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("resolveModel memory behavior", () => {
  it("does not persist explicit model before validation", () => {
    const ref: { current?: string } = {};
    const resolved = resolveModel("claude-sonnet-4-5-20250929", ref, config());
    expect(resolved).toEqual({
      model: "claude-sonnet-4-5-20250929",
      lane: "explicit",
    });
    expect(ref.current).toBeUndefined();
  });

  it("stores only final validated model", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("sonnet-4.5", ref);
    expect(ref.current).toBe("sonnet-4.5");
  });

  it("does not store default sentinel", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("default", ref);
    expect(ref.current).toBeUndefined();
  });
});

describe("cursor-fast lane", () => {
  it("maps cursor-fast to cursorFastModel with lane=fast", () => {
    const ref: { current?: string } = { current: "grok-4.5" };
    expect(resolveModel("cursor-fast", ref, config())).toEqual({
      model: "composer-2.5",
      lane: "fast",
    });
  });

  it("maps fast alias to cursorFastModel with lane=fast", () => {
    expect(resolveModel("fast", { current: "grok-4.5" }, config())).toEqual({
      model: "composer-2.5",
      lane: "fast",
    });
  });

  it("cursor-fast ignores lastRequestedModelRef from previous auto request", () => {
    const ref = { current: "grok-4.5" };
    const m = resolveModel("cursor-fast", ref, config());
    expect(m.model).toBe("composer-2.5");
    expect(m.lane).toBe("fast");
  });

  it("honors custom cursorFastModel", () => {
    expect(
      resolveModel(
        "cursor-fast",
        {},
        config({ cursorFastModel: "composer-2" }),
      ),
    ).toEqual({ model: "composer-2", lane: "fast" });
  });

  it("explicit composer-2.5 is not fast lane", () => {
    expect(resolveModel("composer-2.5", {}, config())).toEqual({
      model: "composer-2.5",
      lane: "explicit",
    });
  });
});

describe("sticky model opt-in", () => {
  it("omitted model uses defaultModel when sticky is off", () => {
    const ref = { current: "grok-4.5" };
    expect(resolveModel(undefined, ref, config())).toEqual({
      model: "auto",
      lane: "default",
    });
  });

  it("omitted model uses lastRequestedModel when stickyModel is true", () => {
    const ref = { current: "grok-4.5" };
    expect(resolveModel(undefined, ref, config({ stickyModel: true }))).toEqual(
      { model: "grok-4.5", lane: "sticky" },
    );
  });

  it("omitted model falls back to defaultModel when sticky on but ref empty", () => {
    expect(
      resolveModel(undefined, {}, config({ stickyModel: true })),
    ).toEqual({ model: "auto", lane: "default" });
  });

  it("unspecified model with defaultModel=composer-2.5 uses that canonical", () => {
    expect(
      resolveModel(
        undefined,
        { current: "grok-4.5" },
        config({ defaultModel: "composer-2.5" }),
      ),
    ).toEqual({ model: "composer-2.5", lane: "default" });
  });
});
