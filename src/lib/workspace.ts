import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { readCachedToken } from "./token-cache.js";

export type WorkspaceResult = {
  workspaceDir: string;
  tempDir?: string;
};

/**
 * Empty per-account gateway HOME under tmp so Cursor does not load rules/MCP
 * from the real user profile, while auth still comes from `CURSOR_CONFIG_DIR`.
 */
export function ensureGatewayHome(accountKey: string): string {
  const hash = createHash("sha256")
    .update(accountKey || "default")
    .digest("hex")
    .slice(0, 16);
  const home = path.join(os.tmpdir(), "cursor-api-proxy-home", hash);
  fs.mkdirSync(home, { recursive: true });
  const cursorDir = path.join(home, ".cursor");
  const rulesDir = path.join(cursorDir, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  // Keep rules empty — never copy from the real user profile.
  for (const name of fs.readdirSync(rulesDir)) {
    try {
      fs.rmSync(path.join(rulesDir, name), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  const cliConfigPath = path.join(cursorDir, "cli-config.json");
  fs.writeFileSync(
    cliConfigPath,
    JSON.stringify(
      {
        version: 1,
        editor: { vimMode: false },
        permissions: { allow: [], deny: [] },
      },
      null,
      0,
    ),
    "utf8",
  );
  // Explicit empty MCP project file so CLI does not invent servers from HOME.
  fs.writeFileSync(
    path.join(cursorDir, "mcp.json"),
    JSON.stringify({ mcpServers: {} }, null, 0),
    "utf8",
  );
  if (process.platform === "win32") {
    fs.mkdirSync(path.join(home, "AppData", "Roaming"), { recursive: true });
    fs.mkdirSync(path.join(home, "AppData", "Local"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  }
  return home;
}

function applyHomeOverrides(
  overrides: Record<string, string>,
  homeDir: string,
): void {
  overrides.HOME = homeDir;
  overrides.USERPROFILE = homeDir;
  if (process.platform === "win32") {
    overrides.APPDATA = path.join(homeDir, "AppData", "Roaming");
    overrides.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
  } else {
    overrides.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  }
}

/**
 * Env overrides for chat-only (isolated) workspace so the agent cannot load
 * rules from ~/.cursor or other user config paths.
 *
 * When `authConfigDir` is set (account pool), `CURSOR_CONFIG_DIR` points at that
 * profile for credentials, while `HOME` / `USERPROFILE` still use an empty
 * gateway home under `os.tmpdir()/cursor-api-proxy-home/<hash>`.
 */
export function getChatOnlyEnvOverrides(
  workspaceDir: string,
  authConfigDir?: string,
): Record<string, string> {
  if (authConfigDir) {
    const gatewayHome = ensureGatewayHome(authConfigDir);
    const overrides: Record<string, string> = {
      CURSOR_CONFIG_DIR: authConfigDir,
    };
    applyHomeOverrides(overrides, gatewayHome);
    // Isolated HOME breaks cursor_login against the real profile; feed the
    // per-account session token so ACP can authenticate without user HOME.
    const token = readCachedToken(authConfigDir);
    if (token) {
      overrides.CURSOR_API_KEY = token;
    }
    return overrides;
  }

  const overrides: Record<string, string> = {
    CURSOR_CONFIG_DIR: path.join(workspaceDir, ".cursor"),
  };
  applyHomeOverrides(overrides, workspaceDir);
  return overrides;
}

export function resolveWorkspace(
  config: BridgeConfig,
  workspaceHeader?: string | string[] | null,
  effectiveChatOnly?: boolean,
): WorkspaceResult {
  const useChatOnly =
    effectiveChatOnly !== undefined
      ? effectiveChatOnly
      : config.chatOnlyWorkspace;
  if (useChatOnly) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    const cursorDir = path.join(tempDir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
    const minimalConfig = {
      version: 1,
      editor: { vimMode: false },
      permissions: { allow: [], deny: [] },
    };
    fs.writeFileSync(
      path.join(cursorDir, "cli-config.json"),
      JSON.stringify(minimalConfig, null, 0),
      "utf8",
    );
    if (process.platform === "win32") {
      fs.mkdirSync(path.join(tempDir, "AppData", "Roaming"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "AppData", "Local"), { recursive: true });
    } else {
      fs.mkdirSync(path.join(tempDir, ".config"), { recursive: true });
    }
    return { workspaceDir: tempDir, tempDir };
  }
  const headerWs =
    typeof workspaceHeader === "string" && workspaceHeader.trim()
      ? workspaceHeader.trim()
      : null;
  const base = path.resolve(config.workspace);
  if (!headerWs) {
    return { workspaceDir: base };
  }

  const candidate = path.resolve(headerWs);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(
      "X-Cursor-Workspace must be an existing directory on the proxy host",
    );
  }

  const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
  const realRequested = fs.realpathSync(candidate);
  const rel = path.relative(realBase, realRequested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      "X-Cursor-Workspace must resolve to a directory under the configured workspace base",
    );
  }
  return { workspaceDir: realRequested };
}
