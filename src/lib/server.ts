import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import { initAccountPool } from "./account-pool.js";
import { killAllChildProcesses } from "./process.js";
import {
  getSessionPool,
  initSessionPool,
  poolAccountKey,
  shutdownSessionPool,
} from "./acp-session-pool.js";
import { ensureGatewayHome, getChatOnlyEnvOverrides } from "./workspace.js";
import * as os from "node:os";

function acpLauncherLabel(acpArgs: string[]): string {
  const first = acpArgs[0];
  if (first && /\.[cm]?js$/i.test(first)) return "node + script";
  return "cmd";
}

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function startBridgeServer(
  opts: BridgeServerOptions,
): (http.Server | https.Server)[] {
  const { config } = opts;
  const servers: (http.Server | https.Server)[] = [];

  if (config.configDirs && config.configDirs.length > 0) {
    if (config.multiPort) {
      // In multi-port mode, we don't need a central pool. We spawn a server for each configDir
      config.configDirs.forEach((dir, index) => {
        const port = config.port + index;
        const serverOpts = {
          ...opts,
          config: {
            ...config,
            port,
            configDirs: [dir], // each server gets only one configDir
            multiPort: false, // Disable multi-port for child servers to prevent recursion
          },
        };
        maybeInitSessionPool(serverOpts.config);
        const server = startSingleServer(serverOpts);
        servers.push(server);
      });
      return servers;
    } else {
      initAccountPool(config.configDirs);
    }
  }

  maybeInitSessionPool(config);
  servers.push(startSingleServer(opts));
  return servers;
}

function maybeInitSessionPool(config: BridgeConfig): void {
  if (!config.sessionPool) return;
  const defaultWarm =
    config.defaultModel === "default" ? undefined : config.defaultModel;
  const fastWarm = config.cursorFastModel?.trim() || undefined;
  if (!getSessionPool()?.enabled) {
    initSessionPool({
      enabled: true,
      minIdle: config.sessionPoolMinIdle,
      maxSessions: config.sessionPoolMaxSessions,
      idleTtlMs: config.sessionPoolIdleTtlMs,
      command: config.acpCommand,
      args: config.acpArgs,
      env: config.acpEnv,
      spawnOptions: config.acpSpawnOptions,
      skipAuthenticate: config.acpSkipAuthenticate,
      defaultModel: defaultWarm,
      fastModel: fastWarm,
      requestTimeoutMs: config.timeoutMs,
      resolveAccountEnv: (accountKey) => {
        // Auth via CURSOR_CONFIG_DIR; HOME is an isolated gateway dir under tmp.
        if (accountKey === "default") {
          return getChatOnlyEnvOverrides(ensureGatewayHome("default"));
        }
        // workspaceDir unused when authConfigDir is set (HOME from gateway hash).
        return getChatOnlyEnvOverrides(os.tmpdir(), accountKey);
      },
    });
  }
  const p = getSessionPool();
  if (!p?.enabled) return;

  // Deduped prewarm targets; empty → one warm with session default (undefined).
  const targets: Array<string | undefined> = [];
  const seen = new Set<string>();
  for (const m of [defaultWarm, fastWarm]) {
    if (m == null || m === "") {
      continue;
    }
    if (seen.has(m)) continue;
    seen.add(m);
    targets.push(m);
  }
  if (targets.length === 0) targets.push(undefined);

  if (
    defaultWarm &&
    fastWarm &&
    defaultWarm !== fastWarm &&
    config.sessionPoolMaxSessions < 2 * config.sessionPoolMinIdle
  ) {
    console.warn(
      `[acp-pool] maxSessions=${config.sessionPoolMaxSessions} < 2*minIdle=${
        2 * config.sessionPoolMinIdle
      }; default+fast prewarm may contend for capacity`,
    );
  }

  const keys =
    config.configDirs?.length > 0
      ? config.configDirs.map((d) => poolAccountKey(d))
      : ["default"];
  for (const k of keys) {
    for (const m of targets) {
      void p.ensureWarm(k, m);
    }
  }
}

/**
 * Register SIGTERM / SIGINT handlers for graceful shutdown.
 * Closes all HTTP(S) servers, kills in-flight agent processes, then exits.
 */
export function setupGracefulShutdown(
  servers: (http.Server | https.Server)[],
  timeoutMs = 10_000,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully…`,
    );

    // Stop accepting new connections and kill all in-flight agent processes
    shutdownSessionPool();
    killAllChildProcesses();

    const closePromises = servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          // closeAllConnections available since Node 18.2
          if (typeof (s as any).closeAllConnections === "function") {
            (s as any).closeAllConnections();
          }
          s.close(() => resolve());
        }),
    );

    const forceExit = setTimeout(() => {
      console.error(
        "[shutdown] Timed out waiting for connections to drain — forcing exit.",
      );
      process.exit(1);
    }, timeoutMs).unref();

    Promise.all(closePromises).then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function startSingleServer(
  opts: BridgeServerOptions,
): http.Server | https.Server {
  const { config } = opts;

  const requestListener = createRequestListener(opts);

  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  let server: http.Server | https.Server;

  if (useTls) {
    const cert = fs.readFileSync(config.tlsCertPath!, "utf8");
    const key = fs.readFileSync(config.tlsKeyPath!, "utf8");
    server = https.createServer({ cert, key }, requestListener);
  } else {
    server = http.createServer(requestListener);
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\u274c Port ${config.port} is already in use. Set CURSOR_BRIDGE_PORT to use a different port.`,
      );
    } else {
      console.error(`\u274c Server error:`, err.message);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const scheme = useTls ? "https" : "http";
    console.log(
      `cursor-api-proxy listening on ${scheme}://${config.host}:${config.port}`,
    );
    console.log(`- agent bin: ${config.agentBin}`);
    console.log(
      `- ACP: ${config.useAcp ? "yes" : "no"}${config.useAcp ? ` (launcher: ${acpLauncherLabel(config.acpArgs)})` : ""}`,
    );
    console.log(
      `- session pool: ${config.sessionPool ? `yes (minIdle=${config.sessionPoolMinIdle}, max=${config.sessionPoolMaxSessions})` : "no"}`,
    );
    console.log(`- workspace: ${config.workspace}`);
    console.log(`- mode: ${config.mode}`);
    console.log(`- default model: ${config.defaultModel}`);
    console.log(`- force: ${config.force}`);
    console.log(`- approve mcps: ${config.approveMcps}`);
    console.log(`- required api key: ${config.requiredKey ? "yes" : "no"}`);
    console.log(`- sessions log: ${config.sessionsLogPath}`);
    console.log(
      `- chat-only workspace: ${config.chatOnlyWorkspace ? "yes (isolated temp dir)" : "no"}`,
    );
    console.log(
      `- verbose traffic: ${config.verbose ? "yes (CURSOR_BRIDGE_VERBOSE=true)" : "no"}`,
    );
    console.log(
      `- max mode: ${config.maxMode ? "yes (CURSOR_BRIDGE_MAX_MODE=true)" : "no"}`,
    );
    console.log(
      `- Windows cmdline budget: ${config.winCmdlineMax} (prompt tail truncation when over limit; Windows only)`,
    );
    if (config.configDirs && config.configDirs.length > 0) {
      console.log(
        `- account pool: enabled with ${config.configDirs.length} configuration directories`,
      );
    }
  });

  return server;
}
