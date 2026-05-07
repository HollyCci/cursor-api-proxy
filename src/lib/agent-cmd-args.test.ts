import { describe, expect, it } from "vitest";

import { buildAgentFixedArgs } from "./agent-cmd-args.js";
import type { BridgeConfig } from "./config.js";

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: "/w",
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/s.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    ...overrides,
  };
}

describe("buildAgentFixedArgs", () => {
  it("passes --mode and --trust when effectiveChatOnly", () => {
    const args = buildAgentFixedArgs(
      cfg(),
      "/ws",
      "gpt-5",
      false,
      "agent",
      true,
    );
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("agent");
    expect(args).toContain("--trust");
  });

  it("omits --trust when not effectiveChatOnly", () => {
    const args = buildAgentFixedArgs(
      cfg({ chatOnlyWorkspace: true }),
      "/ws",
      "gpt-5",
      false,
      "ask",
      false,
    );
    expect(args).not.toContain("--trust");
  });
});
