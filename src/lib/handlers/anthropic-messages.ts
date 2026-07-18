import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import {
  buildBridgeContextPreamble,
  BRIDGE_AGENT_PROMPT_SEPARATOR,
} from "../bridge-context-preamble.js";
import { resolveClientLaunchInfo } from "../client-process.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { recordFinalPoolObservation } from "../pool-metrics.js";
import { poolObservationHeaders } from "../pool-response-headers.js";
import { createStreamParser } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveModelForExecution } from "../model-map.js";
import { normalizeModelId, toolsToSystemText } from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { resolveWorkspace } from "../workspace.js";
import { sanitizeMessages, sanitizeSystem } from "../sanitize.js";
import {
  getNextAccountConfigDirForModel,
  reportRequestStart,
  reportRequestEnd,
  reportRequestSuccess,
  reportRequestError,
  getAccountStats,
  getUsableCount,
} from "../account-pool.js";
import {
  applyAgentAccountSignals,
  isAllAccountsDisabled,
  quarantineAccount,
  NO_USABLE_ACCOUNTS_ERROR,
} from "../account-quarantine.js";
import { shouldDisableForPlanUpgrade } from "../account-failure.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";

function rejectNoUsableAccounts(res: http.ServerResponse): void {
  json(res, 503, { error: { ...NO_USABLE_ACCOUNTS_ERROR } });
}

function rejectColdSpawnCapacity(
  res: http.ServerResponse,
  retryAfterMs?: number,
  extraHeaders?: http.OutgoingHttpHeaders,
): void {
  const retrySec = Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000));
  json(
    res,
    503,
    {
      error: {
        type: "api_error",
        message: "Cold ACP spawn capacity exceeded; retry shortly",
        code: "cold_spawn_capacity",
      },
    },
    {
      ...extraHeaders,
      "Retry-After": String(retrySec),
    },
  );
}

export type AnthropicMessagesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

export async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AnthropicMessagesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as AnthropicMessagesRequest;
  const requested = normalizeModelId(body.model);
  const resolvedReq = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  const decision = resolveModelForExecution({
    requested: resolvedReq.model,
    defaultModel: config.defaultModel,
    availableCursorIds: models.map((m) => m.id),
    lane: resolvedReq.lane,
  });
  if (!decision.ok) {
    json(res, 503, {
      error: {
        type: "api_error",
        message: `Cursor fast model unavailable: ${resolvedReq.model}`,
        code: "cursor_fast_unavailable",
      },
    });
    return;
  }
  const cursorModel = decision.final;
  const model = cursorModel;
  const requireExactModel = resolvedReq.lane === "fast";
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  const displayModel = decision.final;

  const cleanSystem = sanitizeSystem(body.system);
  const cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

  const toolsText = toolsToSystemText((body as any).tools);
  const systemWithTools = toolsText
    ? [cleanSystem, toolsText].filter(Boolean).join("\n\n")
    : cleanSystem;
  const prompt = buildPromptFromAnthropicMessages(
    cleanMessages,
    systemWithTools as AnthropicMessagesRequest["system"],
  );

  if (body.max_tokens == null || typeof body.max_tokens !== "number") {
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "max_tokens is required",
      },
    });
    return;
  }

  const trafficMessages: TrafficMessage[] = [];
  if (cleanSystem) {
    const sys =
      typeof cleanSystem === "string"
        ? cleanSystem
        : (cleanSystem as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    if (sys.trim())
      trafficMessages.push({ role: "system", content: sys.trim() });
  }
  for (const m of cleanMessages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (text) trafficMessages.push({ role: m.role, content: text });
  }
  logTrafficRequest(
    config.verbose,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  let mode: CursorExecutionMode;
  try {
    mode = resolveRequestMode(
      config,
      req.headers["x-cursor-mode"],
      body.mode,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: msg,
        code: "invalid_mode",
      },
    });
    return;
  }

  const effectiveChatOnly =
    mode === "ask"
      ? config.chatOnlyWorkspace
      : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;

  const headerWs = req.headers["x-cursor-workspace"];
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, {
      error: { type: "invalid_request_error", message: msg },
    });
    return;
  }

  const agentPrompt = config.contextPreamble
    ? `${buildBridgeContextPreamble({
        headers: req.headers,
        bridgeWorkspaceBase: config.workspace,
        agentWorkspaceDir: workspaceDir,
        isolatedChatOnly: tempDir !== undefined,
        cursorMode: mode,
        contextExtra: config.contextExtra,
      })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${prompt}`
    : prompt;

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
    mode,
    effectiveChatOnly,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
    maxCmdline: config.winCmdlineMax,
    platform: process.platform,
    cwd: workspaceDir,
  });
  if (!fit.ok) {
    json(res, 500, {
      error: {
        type: "api_error",
        message: fit.error,
        code: "windows_cmdline_limit",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }
  const cmdArgs = fit.args;

  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  if (body.stream) {
    const abortController = new AbortController();
    req.once("close", () => abortController.abort());

    let configDir = getNextAccountConfigDirForModel(cursorModel);
    if (isAllAccountsDisabled(configDir)) {
      rejectNoUsableAccounts(res);
      return;
    }

    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    let sseCommitted = false;
    const writeEvent = (evt: object) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    const commitSse = () => {
      if (sseCommitted || res.headersSent) return;
      sseCommitted = true;
      writeSseHeaders(res, truncatedHeaders);
      res.on("error", () => {
        /* client disconnected mid-stream */
      });
      writeEvent({
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: displayModel ?? cursorModel,
          content: [],
        },
      });
      writeEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    };

    const endPlanUpgradeStream = (contentStarted: boolean) => {
      commitSse();
      if (
        !contentStarted &&
        getAccountStats().length > 0 &&
        getUsableCount() === 0
      ) {
        writeEvent({
          type: "error",
          error: {
            type: "api_error",
            message: NO_USABLE_ACCOUNTS_ERROR.message,
            code: NO_USABLE_ACCOUNTS_ERROR.code,
          },
        });
      } else {
        writeEvent({
          type: "error",
          error: {
            type: "api_error",
            message: "Cursor account plan upgrade required",
            code: "account_plan_upgrade",
          },
        });
      }
      logAccountStats(config.verbose, getAccountStats());
      res.end();
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      void (async () => {
        let attempts = 0;
        let contentStarted = false;
        let midUpgrade = false;
        let activeDir = configDir;
        let accumulated = "";
        let streamPoolObs: Parameters<
          typeof recordFinalPoolObservation
        >[0];

        while (attempts < 2) {
          attempts++;
          if (attempts > 1) {
            reportRequestEnd(activeDir);
            activeDir = getNextAccountConfigDirForModel(cursorModel);
            if (isAllAccountsDisabled(activeDir)) {
              recordFinalPoolObservation(streamPoolObs);
              endPlanUpgradeStream(false);
              return;
            }
            logAccountAssigned(activeDir);
            reportRequestStart(activeDir);
          }

          accumulated = "";
          contentStarted = false;
          midUpgrade = false;

          try {
            const out = await runAgentStream(
              config,
              workspaceDir,
              effectiveChatOnly,
              cmdArgs,
              (chunk) => {
                if (midUpgrade) return;
                accumulated += chunk;
                if (
                  shouldDisableForPlanUpgrade({
                    text: accumulated,
                    fromErrorChannel: false,
                  })
                ) {
                  quarantineAccount(activeDir, "upgrade_plan");
                  midUpgrade = true;
                  abortController.abort();
                  return;
                }
                contentStarted = true;
                commitSse();
                writeEvent({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: chunk },
                });
              },
              tempDir,
              promptForAgent,
              activeDir,
              abortController.signal,
              undefined,
              requireExactModel,
            );
            if (out.poolObservation) streamPoolObs = out.poolObservation;
            const latencyMs = Date.now() - streamStart;
            reportRequestEnd(activeDir);

            if (out.admissionDenied) {
              recordFinalPoolObservation(streamPoolObs);
              if (!res.headersSent) {
                rejectColdSpawnCapacity(
                  res,
                  out.retryAfterMs,
                  truncatedHeaders,
                );
              } else {
                commitSse();
                writeEvent({
                  type: "error",
                  error: {
                    type: "api_error",
                    message: "Cold ACP spawn capacity exceeded; retry shortly",
                    code: "cold_spawn_capacity",
                  },
                });
                res.end();
              }
              return;
            }

            const signal = midUpgrade
              ? ("plan_upgrade" as const)
              : applyAgentAccountSignals(activeDir, {
                  code: out.code,
                  stderr: out.stderr,
                  stdout: accumulated,
                });

            if (abortController.signal.aborted) {
              recordFinalPoolObservation(streamPoolObs);
              if (res.headersSent) res.end();
              return;
            }

            if (signal === "plan_upgrade") {
              reportRequestError(activeDir, latencyMs);
              if (!contentStarted && attempts < 2) continue;
              recordFinalPoolObservation(streamPoolObs);
              endPlanUpgradeStream(contentStarted);
              return;
            }

            if (out.code !== 0) {
              reportRequestError(activeDir, latencyMs);
              const publicMsg = logAgentError(
                config.sessionsLogPath,
                method,
                pathname,
                remoteAddress,
                out.code,
                out.stderr,
              );
              commitSse();
              writeEvent({
                type: "error",
                error: { type: "api_error", message: publicMsg },
              });
            } else {
              reportRequestSuccess(activeDir, latencyMs);
              logTrafficResponse(
                config.verbose,
                model ?? cursorModel,
                accumulated,
                true,
              );
              commitSse();
              writeEvent({ type: "content_block_stop", index: 0 });
              writeEvent({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 0 },
              });
              writeEvent({ type: "message_stop" });
            }
            logAccountStats(config.verbose, getAccountStats());
            recordFinalPoolObservation(streamPoolObs);
            res.end();
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reportRequestEnd(activeDir);
            const signal = applyAgentAccountSignals(activeDir, {
              code: 1,
              stdout: "",
              stderr: msg,
              failureText: msg,
            });
            if (!abortController.signal.aborted) {
              reportRequestError(activeDir, Date.now() - streamStart);
              if (signal === "plan_upgrade" && !contentStarted && attempts < 2) {
                continue;
              }
              if (signal === "plan_upgrade") {
                recordFinalPoolObservation(streamPoolObs);
                endPlanUpgradeStream(contentStarted);
                return;
              }
              commitSse();
              writeEvent({
                type: "error",
                error: {
                  type: "api_error",
                  message:
                    "The Cursor agent stream failed. See server logs for details.",
                },
              });
            }
            console.error(
              `[${new Date().toISOString()}] Agent stream error:`,
              err,
            );
            recordFinalPoolObservation(streamPoolObs);
            if (res.headersSent) res.end();
            return;
          }
        }
      })();
      return;
    }

    let accumulated = "";
    let contentStarted = false;
    let midUpgrade = false;
    const parseLine = createStreamParser(
      (text) => {
        if (midUpgrade) return;
        accumulated += text;
        if (
          shouldDisableForPlanUpgrade({
            text: accumulated,
            fromErrorChannel: false,
          })
        ) {
          quarantineAccount(configDir, "upgrade_plan");
          midUpgrade = true;
          abortController.abort();
          return;
        }
        contentStarted = true;
        commitSse();
        writeEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        });
      },
      () => {
        if (midUpgrade) return;
        logTrafficResponse(
          config.verbose,
          model ?? cursorModel,
          accumulated,
          true,
        );
        commitSse();
        writeEvent({ type: "content_block_stop", index: 0 });
        writeEvent({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        writeEvent({ type: "message_stop" });
      },
    );

    runAgentStream(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      undefined,
      requireExactModel,
    )
      .then((out) => {
        recordFinalPoolObservation(out.poolObservation);
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (out.admissionDenied) {
          if (!res.headersSent) {
            rejectColdSpawnCapacity(res, out.retryAfterMs, truncatedHeaders);
          } else {
            commitSse();
            writeEvent({
              type: "error",
              error: {
                type: "api_error",
                message: "Cold ACP spawn capacity exceeded; retry shortly",
                code: "cold_spawn_capacity",
              },
            });
            res.end();
          }
          return;
        }

        const signal = midUpgrade
          ? ("plan_upgrade" as const)
          : applyAgentAccountSignals(configDir, {
              code: out.code,
              stderr: out.stderr,
              stdout: accumulated,
            });

        if (abortController.signal.aborted) {
          if (res.headersSent) res.end();
          return;
        }
        if (signal === "plan_upgrade") {
          reportRequestError(configDir, latencyMs);
          endPlanUpgradeStream(contentStarted);
          return;
        }
        if (out.code !== 0) {
          reportRequestError(configDir, latencyMs);
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            out.code,
            out.stderr,
          );
        } else {
          reportRequestSuccess(configDir, latencyMs);
        }
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        reportRequestEnd(configDir);
        const signal = applyAgentAccountSignals(configDir, {
          code: 1,
          stdout: "",
          stderr: msg,
          failureText: msg,
        });
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
          if (signal === "plan_upgrade") {
            endPlanUpgradeStream(contentStarted);
            return;
          }
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        res.end();
      });
    return;
  }

  const abortController = new AbortController();
  req.once("close", () => abortController.abort());

  let configDir: string | undefined;
  let out!: Awaited<ReturnType<typeof runAgentSync>>;
  let syncLatency = 0;
  let lastSignal: ReturnType<typeof applyAgentAccountSignals> = "other";

  for (let attempts = 0; attempts < 2; attempts++) {
    configDir = getNextAccountConfigDirForModel(cursorModel);
    if (isAllAccountsDisabled(configDir)) {
      rejectNoUsableAccounts(res);
      return;
    }
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const syncStart = Date.now();

    out = await runAgentSync(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      requireExactModel,
    );
    syncLatency = Date.now() - syncStart;
    reportRequestEnd(configDir);

    if (out.admissionDenied) {
      break;
    }

    lastSignal = applyAgentAccountSignals(configDir, out);
    if (lastSignal === "plan_upgrade" && attempts < 1) {
      reportRequestError(configDir, syncLatency);
      continue;
    }
    break;
  }

  // One observation per HTTP request (final account attempt only).
  recordFinalPoolObservation(out.poolObservation);
  const poolHeaders = poolObservationHeaders(out.poolObservation);

  if (out.admissionDenied) {
    rejectColdSpawnCapacity(res, out.retryAfterMs, {
      ...truncatedHeaders,
      ...poolHeaders,
    });
    return;
  }

  if (lastSignal === "plan_upgrade") {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    if (getAccountStats().length > 0 && getUsableCount() === 0) {
      rejectNoUsableAccounts(res);
      return;
    }
    json(
      res,
      500,
      {
        error: {
          type: "api_error",
          message: "Cursor account plan upgrade required",
          code: "account_plan_upgrade",
        },
      },
      { ...truncatedHeaders, ...poolHeaders },
    );
    return;
  }

  if (out.code !== 0) {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      out.code,
      out.stderr,
    );
    json(
      res,
      500,
      {
        error: { type: "api_error", message: errMsg, code: "cursor_cli_error" },
      },
      { ...truncatedHeaders, ...poolHeaders },
    );
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
  logAccountStats(config.verbose, getAccountStats());
  const inTok = Math.max(1, Math.round(agentPrompt.length / 4));
  const outTok = Math.max(1, Math.round(content.length / 4));
  json(
    res,
    200,
    {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      model: displayModel ?? cursorModel,
      stop_reason: "end_turn",
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
      },
    },
    { ...truncatedHeaders, ...poolHeaders },
  );
}
