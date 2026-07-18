import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { runDoctor } from "./doctor.js";

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "composer-2.5",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: false,
    stickyModel: false,
    cursorFastModel: "composer-2.5",
    workspace: "/tmp/proj-base",
    timeoutMs: 300_000,
    sessionsLogPath: "/tmp/sessions.log",
    chatOnlyWorkspace: false,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
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

describe("runDoctor", () => {
  it("reports account dir missing as failure", () => {
    const missing = path.join(os.tmpdir(), "cursor-doctor-missing-" + Date.now());
    const result = runDoctor(
      baseConfig({
        useAcp: true,
        configDirs: [missing],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.name.startsWith("accountDir:") && !c.ok)).toBe(
      true,
    );
  });

  it("passes when account dir exists and ACP is on", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-doctor-acc-"));
    const result = runDoctor(
      baseConfig({
        useAcp: true,
        defaultModel: "composer-2.5",
        configDirs: [dir],
        sessionPool: true,
      }),
    );
    const accountCheck = result.checks.find((c) => c.name.startsWith("accountDir:"));
    expect(accountCheck?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "useAcp")?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "sessionPool")?.detail).toMatch(
      /enabled/,
    );
    expect(result.checks.find((c) => c.name === "poolStats")).toBeDefined();
  });

  it("fails sessionPool when ACP is on but pool is off", () => {
    const result = runDoctor(
      baseConfig({
        useAcp: true,
        sessionPool: false,
      }),
    );
    expect(result.checks.find((c) => c.name === "sessionPool")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
