/**
 * Long-lived ACP process that can host multiple virgin sessions.
 * Events are demuxed by sessionId; unknown sessions are fail-closed (dropped + warn).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { debuglog } from "node:util";
import { randomUUID } from "node:crypto";

import { trackChildProcess } from "./process.js";
import {
  extractAcpUpdateText,
  resolveAcpModelConfigValue,
  type AcpAvailableModel,
} from "./acp-client.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timerId?: ReturnType<typeof setTimeout>;
  method: string;
};

export type AcpConnectionOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  skipAuthenticate?: boolean;
  requestTimeoutMs?: number;
  /** Account key for logging / pool indexing. */
  accountKey?: string;
};

export type VirginSession = {
  sessionId: string;
  availableModels?: AcpAvailableModel[];
  createdAt: number;
  /** Per-session empty cwd (caller should delete on discard). */
  sessionCwd: string;
  /** Normalized model key actually applied (or __default__). */
  effectiveModel: string;
};

function buildSpawnEnv(
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inheritKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "PUBLIC",
    "NODE_OPTIONS",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of inheritKeys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function respond(stdin: NodeJS.WritableStream, id: number, result: object): void {
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n", "utf8");
}

export function normalizePoolModelKey(
  model: string | undefined,
  defaultModel?: string,
): string {
  const m = (model ?? defaultModel ?? "").trim();
  if (!m || m === "default") return "__default__";
  return m;
}

export class AcpConnection {
  readonly id = randomUUID().slice(0, 8);
  readonly accountKey: string;
  private child: ChildProcess;
  private readonly stdin: NodeJS.WritableStream;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly requestTimeoutMs: number;
  private dead = false;
  private readonly activeHandlers = new Map<
    string,
    {
      onText?: (text: string) => void;
      onThought?: (text: string) => void;
    }
  >();
  private readonly cwd: string;

  private constructor(
    child: ChildProcess,
    opts: AcpConnectionOptions & { requestTimeoutMs: number },
  ) {
    this.child = child;
    this.stdin = child.stdin!;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.accountKey = opts.accountKey ?? "default";
    this.cwd = opts.cwd;

    trackChildProcess(child);

    child.stdin?.on("error", (err) => {
      debugAcp("ACP stdin error: %s", err);
      this.markDead(err instanceof Error ? err : new Error(String(err)));
    });

    child.stderr?.setEncoding("utf8");
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onLine(line));

    child.on("error", () => {
      this.markDead(new Error("ACP child error"));
    });
    child.on("close", () => {
      this.markDead(new Error("ACP child closed"));
    });
  }

  static async start(opts: AcpConnectionOptions): Promise<AcpConnection> {
    const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: buildSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });
    if (!child.stdin || !child.stdout) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      throw new Error("ACP spawn missing stdio");
    }
    const conn = new AcpConnection(child, { ...opts, requestTimeoutMs });
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cursor-api-proxy", version: "1.1.1-towords.1" },
    });
    if (!opts.skipAuthenticate) {
      await conn.request("authenticate", { methodId: "cursor_login" });
    }
    return conn;
  }

  get isDead(): boolean {
    return this.dead;
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) {
      if (p.timerId) clearTimeout(p.timerId);
      p.reject(err);
    }
    this.pending.clear();
    this.activeHandlers.clear();
  }

  private request(method: string, params: object): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("ACP connection dead"));
    const id = this.nextId++;
    try {
      this.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        "utf8",
      );
    } catch (err) {
      this.markDead(err instanceof Error ? err : new Error(String(err)));
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(`ACP ${method} timed out after ${this.requestTimeoutMs}ms`),
          );
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timerId, method });
    });
  }

  private onLine(line: string): void {
    const t = line.replace(/\r$/, "").trim();
    if (!t) return;
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(Number(msg.id));
      if (!waiter) return;
      this.pending.delete(Number(msg.id));
      if (waiter.timerId) clearTimeout(waiter.timerId);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message ?? "ACP error"));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "session/update") {
      const params = msg.params ?? {};
      const update = (params.update ?? params) as {
        sessionUpdate?: string;
        content?:
          | { text?: string }
          | Array<{ content?: { text?: string }; text?: string }>;
      };
      const sessionId = String(
        params.sessionId ?? (update as { sessionId?: string }).sessionId ?? "",
      );
      const sessionUpdate = update?.sessionUpdate;
      const text = extractAcpUpdateText(update?.content);
      if (!text) return;
      if (
        sessionUpdate !== "agent_message_chunk" &&
        sessionUpdate !== "agent_thought_chunk"
      ) {
        return;
      }
      const handler = sessionId ? this.activeHandlers.get(sessionId) : undefined;
      if (!handler) {
        console.warn(
          `[acp-pool] drop session/update text for non-checked-out sessionId=${sessionId || "(missing)"} conn=${this.id}`,
        );
        return;
      }
      if (sessionUpdate === "agent_thought_chunk") {
        handler.onThought?.(text);
      } else {
        handler.onText?.(text);
      }
      return;
    }

    if (msg.method === "session/request_permission" && msg.id != null) {
      respond(this.stdin, msg.id, {
        outcome: { outcome: "selected", optionId: "reject-once" },
      });
      return;
    }

    if (msg.method && msg.id != null && String(msg.method).startsWith("cursor/")) {
      respond(this.stdin, msg.id, {});
    }
  }

  /**
   * Create a virgin session with its own empty cwd (isolation).
   */
  async createVirginSession(
    model: string | undefined,
    defaultModel?: string,
    opts?: { requireExactModel?: boolean },
  ): Promise<VirginSession> {
    const sessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "cursor-api-proxy-sess-"),
    );
    const effectiveModel = normalizePoolModelKey(model, defaultModel);
    const cleanupFailed = async (sessionId?: string) => {
      if (sessionId) {
        try {
          await this.cancel(sessionId);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(sessionCwd, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    const result = (await this.request("session/new", {
      cwd: sessionCwd,
      mcpServers: [],
    })) as {
      sessionId?: string;
      models?: { availableModels?: AcpAvailableModel[] };
    };
    const sessionId = result.sessionId;
    if (!sessionId) {
      await cleanupFailed();
      throw new Error("ACP session/new missing sessionId");
    }

    if (effectiveModel !== "__default__") {
      let resolved: string;
      try {
        resolved = resolveAcpModelConfigValue(
          effectiveModel,
          result.models?.availableModels,
          { strict: opts?.requireExactModel },
        );
      } catch (err) {
        await cleanupFailed(sessionId);
        throw err;
      }
      if (resolved !== "default" && resolved !== "default[]") {
        try {
          await this.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: resolved,
          });
        } catch (err) {
          if (opts?.requireExactModel) {
            await cleanupFailed(sessionId);
            throw err;
          }
          debugAcp("set_config_option model failed: %s", err);
        }
      } else if (opts?.requireExactModel) {
        await cleanupFailed(sessionId);
        throw new Error(
          `ACP model unavailable: cannot pin ${effectiveModel} (resolved ${resolved})`,
        );
      }
    }

    return {
      sessionId,
      availableModels: result.models?.availableModels,
      createdAt: Date.now(),
      sessionCwd,
      effectiveModel,
    };
  }

  /**
   * Run one prompt on a virgin session. Registers demux handler only for this sessionId.
   */
  async promptOnce(
    sessionId: string,
    prompt: string,
    opts?: {
      onChunk?: (text: string) => void;
      onThoughtChunk?: (text: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<{
    stdout: string;
    reasoning?: string;
    latencyMarks: Record<string, number>;
  }> {
    if (this.activeHandlers.has(sessionId)) {
      throw new Error(`session already checked out: ${sessionId}`);
    }
    if (opts?.signal?.aborted) {
      throw new Error("ACP prompt aborted before send");
    }
    const marks: Record<string, number> = {
      prompt_dispatch_start: performance.now(),
    };
    let accumulated = "";
    let accumulatedThought = "";
    this.activeHandlers.set(sessionId, {
      onText: (text) => {
        if (marks.model_first_byte == null) {
          marks.model_first_byte = performance.now();
        }
        accumulated += text;
        opts?.onChunk?.(text);
      },
      onThought: (text) => {
        if (marks.model_first_byte == null) {
          marks.model_first_byte = performance.now();
        }
        accumulatedThought += text;
        opts?.onThoughtChunk?.(text);
      },
    });

    const onAbort = () => {
      void this.cancel(sessionId).catch(() => undefined);
    };
    if (opts?.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      marks.prompt_dispatched = performance.now();
      await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      marks.model_complete = performance.now();
      const reasoning = accumulatedThought.trim();
      return {
        stdout: accumulated,
        ...(reasoning ? { reasoning } : {}),
        latencyMarks: marks,
      };
    } finally {
      this.activeHandlers.delete(sessionId);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.request("session/cancel", { sessionId });
    } catch {
      /* cancel may be unsupported; session is discarded anyway */
    }
    this.activeHandlers.delete(sessionId);
  }

  kill(): void {
    this.markDead(new Error("ACP connection killed"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}
