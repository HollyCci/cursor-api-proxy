import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getChatOnlyEnvOverrides, resolveWorkspace } from "./workspace.js";
import type { BridgeConfig } from "./config.js";

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    useAcp: false,
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

describe("getChatOnlyEnvOverrides", () => {
  it("uses temp workspace .cursor when no auth pool dir", () => {
    const tmp = "/tmp/cursor-proxy-abc123";
    const o = getChatOnlyEnvOverrides(tmp);
    expect(o.CURSOR_CONFIG_DIR).toBe(`${tmp}/.cursor`);
  });

  it("uses account pool path for CURSOR_CONFIG_DIR when provided", () => {
    const tmp = "/tmp/cursor-proxy-abc123";
    const pool = "/home/u/.cursor-api-proxy/accounts/account-5765";
    const o = getChatOnlyEnvOverrides(tmp, pool);
    expect(o.CURSOR_CONFIG_DIR).toBe(pool);
    // Auth stays on the account dir; HOME must still be an isolated gateway home.
    expect(o.HOME).toBeDefined();
    expect(o.HOME).toContain(path.join(os.tmpdir(), "cursor-api-proxy-home"));
    expect(o.HOME).not.toBe(pool);
    expect(o.USERPROFILE).toBe(o.HOME);
  });

  it("isolates HOME under tmp even when authConfigDir is set", () => {
    const pool = path.join(os.tmpdir(), "cursor-api-proxy-accounts-test", "acc1");
    fs.mkdirSync(pool, { recursive: true });
    const o = getChatOnlyEnvOverrides("/tmp/cursor-proxy-ws", pool);
    expect(o.CURSOR_CONFIG_DIR).toBe(pool);
    expect(o.HOME).toMatch(
      new RegExp(
        `${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]cursor-api-proxy-home[/\\\\][a-f0-9]+`,
      ),
    );
    expect(fs.existsSync(o.HOME!)).toBe(true);
  });

  it("gateway HOME does not surface injected user rules or MCP servers", () => {
    const userHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "cursor-fake-user-home-"),
    );
    const userCursor = path.join(userHome, ".cursor");
    fs.mkdirSync(path.join(userCursor, "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(userCursor, "rules", "leak.mdc"),
      "# should not be visible",
      "utf8",
    );
    fs.writeFileSync(
      path.join(userCursor, "mcp.json"),
      JSON.stringify({
        mcpServers: { evil: { command: "echo", args: ["pwn"] } },
      }),
      "utf8",
    );
    const pool = path.join(os.tmpdir(), "cursor-api-proxy-accounts-test", "acc2");
    fs.mkdirSync(pool, { recursive: true });

    const prevHome = process.env.HOME;
    process.env.HOME = userHome;
    try {
      const o = getChatOnlyEnvOverrides("/tmp/cursor-proxy-ws", pool);
      expect(o.HOME).toBeDefined();
      expect(o.HOME).not.toBe(userHome);
      const gatewayRules = path.join(o.HOME!, ".cursor", "rules");
      expect(fs.existsSync(path.join(gatewayRules, "leak.mdc"))).toBe(false);
      expect(fs.readdirSync(gatewayRules)).toEqual([]);
      const mcp = JSON.parse(
        fs.readFileSync(path.join(o.HOME!, ".cursor", "mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers).toEqual({});
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("resolveWorkspace", () => {
  it("uses temp dir when chat-only is effective", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    expect(tempDir).toBeDefined();
    expect(workspaceDir).toContain("cursor-proxy-");
  });

  it("uses real workspace when effectiveChatOnly is false despite config.chatOnlyWorkspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-real-"));
    const cfg = baseConfig({ workspace: tmp, chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined, false);
    expect(tempDir).toBeUndefined();
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(tmp));
  });

  it("rejects X-Cursor-Workspace outside configured base", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-base-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-out-"));
    const cfg = baseConfig({ workspace: tmp });
    expect(() => resolveWorkspace(cfg, outside)).toThrow(
      /under the configured workspace base/,
    );
  });

  it("allows header path under workspace base", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-base-"));
    const sub = path.join(tmp, "pkg", "src");
    fs.mkdirSync(sub, { recursive: true });
    const cfg = baseConfig({ workspace: tmp });
    const { workspaceDir } = resolveWorkspace(cfg, sub);
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(sub));
  });
});
