import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { recordFinalPoolObservation } from "../pool-metrics.js";
import { poolObservationHeaders } from "../pool-response-headers.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveModelForExecution } from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
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
import { buildBridgeContextPreamble, BRIDGE_AGENT_PROMPT_SEPARATOR } from "../bridge-context-preamble.js";
import { sanitizeMessages } from "../sanitize.js";
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
import {
  buildBufferedStreamChunks,
  buildToolBridgeSystemText,
  containsToolCallCandidate,
  parseToolCallOutput,
  resolveAssistantOutput,
  shouldUseToolBridge,
} from "../tool-calls.js";
import { LatencyWaterfall } from "../latency-waterfall.js";
import {
  thoughtStreamDelta,
  withReasoningContent,
} from "../thought-mode.js";

function writeChatSseError(
  res: http.ServerResponse,
  message: string,
  code: string,
): void {
  res.write(
    `data: ${JSON.stringify({ error: { message, code } })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
}

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
        message: "Cold ACP spawn capacity exceeded; retry shortly",
        code: "cold_spawn_capacity",
        type: "api_error",
      },
    },
    {
      ...extraHeaders,
      "Retry-After": String(retrySec),
    },
  );
}

function usageFor(prompt: string, completion: string) {
  const prompt_tokens = Math.max(1, Math.round(prompt.length / 4));
  const completion_tokens = Math.max(1, Math.round(completion.length / 4));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

function writeBufferedEvents(
  res: http.ServerResponse,
  chunks: object[],
): void {
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
}

function maybeWarnThoughtOnly(content: string, reasoning?: string): void {
  if (!content.trim() && reasoning?.trim()) {
    console.warn(
      "[acp] thought-only response; leaving content empty (not falling back to thought)",
    );
  }
}

export type ChatCompletionsCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatCompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const latency = new LatencyWaterfall();
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
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
    json(
      res,
      503,
      {
        error: {
          message: `Cursor fast model unavailable: ${resolvedReq.model}`,
          code: "cursor_fast_unavailable",
        },
      },
    );
    return;
  }
  const cursorModel = decision.final;
  const model = cursorModel;
  const requireExactModel = resolvedReq.lane === "fast";
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  // Report the model actually executed (never a silent fallback label).
  const displayModel = decision.final;

  const cleanMessages = sanitizeMessages(body.messages ?? []);

  const toolBridgeActive =
    config.toolCalls && shouldUseToolBridge(body.tools, body.tool_choice);
  const toolsText = config.toolCalls
    ? toolBridgeActive
      ? buildToolBridgeSystemText(body.tools, body.tool_choice)
      : undefined
    : toolsToSystemText(body.tools, body.functions);
  const messagesWithTools = toolsText
    ? [{ role: "system", content: toolsText }, ...cleanMessages]
    : cleanMessages;
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => {
    const content =
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : "";
    return { role: String(m?.role ?? "user"), content };
  });
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
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
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
    json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
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
        message: fit.error,
        code: "windows_cmdline_limit",
        type: "api_error",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }
  const cmdArgs = fit.args;

  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

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

    // Defer SSE headers until first chunk or confirmed run so admission
    // denials can still return JSON 503 + Retry-After.
    let sseCommitted = false;
    const commitSse = () => {
      if (sseCommitted || res.headersSent) return;
      sseCommitted = true;
      writeSseHeaders(res, truncatedHeaders);
      res.on("error", () => {
        /* client disconnected mid-stream */
      });
    };

    const endPlanUpgradeStream = (contentStarted: boolean) => {
      commitSse();
      if (
        !contentStarted &&
        getAccountStats().length > 0 &&
        getUsableCount() === 0
      ) {
        writeChatSseError(
          res,
          NO_USABLE_ACCOUNTS_ERROR.message,
          NO_USABLE_ACCOUNTS_ERROR.code,
        );
      } else {
        writeChatSseError(
          res,
          "Cursor account plan upgrade required",
          "account_plan_upgrade",
        );
      }
      logAccountStats(config.verbose, getAccountStats());
      res.end();
    };

    if (toolBridgeActive) {
      void (async () => {
        let attempts = 0;
        let accumulated = "";
        let accumulatedThought = "";
        let activeDir = configDir;
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
          accumulatedThought = "";
          const onLine = config.useAcp
            ? (text: string) => {
                accumulated += text;
              }
            : createStreamParser(
                (text) => {
                  accumulated += text;
                },
                () => {},
              );
          const onThought = config.useAcp
            ? (text: string) => {
                accumulatedThought += text;
              }
            : undefined;

          try {
            const out = await runAgentStream(
              config,
              workspaceDir,
              effectiveChatOnly,
              cmdArgs,
              onLine,
              tempDir,
              promptForAgent,
              activeDir,
              abortController.signal,
              onThought,
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
                writeChatSseError(
                  res,
                  "Cold ACP spawn capacity exceeded; retry shortly",
                  "cold_spawn_capacity",
                );
                res.end();
              }
              return;
            }

            const signal = applyAgentAccountSignals(activeDir, {
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
              if (attempts < 2) continue;
              recordFinalPoolObservation(streamPoolObs);
              endPlanUpgradeStream(false);
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
              writeChatSseError(res, publicMsg, "cursor_cli_error");
              logAccountStats(config.verbose, getAccountStats());
              recordFinalPoolObservation(streamPoolObs);
              res.end();
              return;
            }

            reportRequestSuccess(activeDir, latencyMs);
            logAccountStats(config.verbose, getAccountStats());
            logTrafficResponse(
              config.verbose,
              model ?? cursorModel,
              accumulated,
              true,
            );
            maybeWarnThoughtOnly(accumulated, accumulatedThought);
            if (
              containsToolCallCandidate(accumulated) &&
              !parseToolCallOutput(accumulated, body.tools, {
                toolChoice: body.tool_choice,
              })
            ) {
              console.warn(
                `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
              );
            }
            const buffered = buildBufferedStreamChunks({
              id,
              created,
              model: displayModel,
              text: accumulated,
              tools: body.tools,
              usage: usageFor(agentPrompt, accumulated),
              options: { toolChoice: body.tool_choice },
            });
            const reasoningDelta = thoughtStreamDelta(
              accumulatedThought,
              config.thoughtMode,
            );
            if (reasoningDelta) {
              buffered.unshift({
                id,
                object: "chat.completion.chunk",
                created,
                model: displayModel,
                choices: [
                  {
                    index: 0,
                    delta: reasoningDelta,
                    finish_reason: null,
                  },
                ],
              });
            }
            commitSse();
            writeBufferedEvents(res, buffered);
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
              if (signal === "plan_upgrade" && attempts < 2) continue;
              if (signal === "plan_upgrade") {
                recordFinalPoolObservation(streamPoolObs);
                endPlanUpgradeStream(false);
                return;
              }
              commitSse();
              writeChatSseError(
                res,
                "The Cursor agent stream failed. See server logs for details.",
                "cursor_cli_error",
              );
            }
            console.error(
              `[${new Date().toISOString()}] Agent stream error:`,
              err,
            );
            recordFinalPoolObservation(streamPoolObs);
            res.end();
            return;
          }
        }
      })();
      return;
    }

    if (config.useAcp && typeof promptForAgent === "string") {
      void (async () => {
        let attempts = 0;
        let contentStarted = false;
        let midUpgrade = false;
        let activeDir = configDir;
        let accumulated = "";
        let accumulatedThought = "";
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
          accumulatedThought = "";
          contentStarted = false;
          midUpgrade = false;

          const onThought = (chunk: string) => {
            if (midUpgrade) return;
            accumulatedThought += chunk;
            const delta = thoughtStreamDelta(chunk, config.thoughtMode);
            if (!delta) return;
            contentStarted = true;
            commitSse();
            res.write(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: displayModel,
                choices: [{ index: 0, delta, finish_reason: null }],
              })}\n\n`,
            );
          };

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
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: displayModel,
                    choices: [
                      {
                        index: 0,
                        delta: { content: chunk },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                );
              },
              tempDir,
              promptForAgent,
              activeDir,
              abortController.signal,
              onThought,
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
                writeChatSseError(
                  res,
                  "Cold ACP spawn capacity exceeded; retry shortly",
                  "cold_spawn_capacity",
                );
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
              writeChatSseError(res, publicMsg, "cursor_cli_error");
              logAccountStats(config.verbose, getAccountStats());
              recordFinalPoolObservation(streamPoolObs);
              res.end();
              return;
            }

            reportRequestSuccess(activeDir, latencyMs);
            logAccountStats(config.verbose, getAccountStats());
            logTrafficResponse(
              config.verbose,
              model ?? cursorModel,
              accumulated,
              true,
            );
            maybeWarnThoughtOnly(accumulated, accumulatedThought);
            const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
            const completionTokens = Math.max(
              1,
              Math.round(accumulated.length / 4),
            );
            commitSse();
            res.write(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: displayModel,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: promptTokens + completionTokens,
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
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
              writeChatSseError(
                res,
                "The Cursor agent stream failed. See server logs for details.",
                "cursor_cli_error",
              );
            }
            console.error(
              `[${new Date().toISOString()}] Agent stream error:`,
              err,
            );
            recordFinalPoolObservation(streamPoolObs);
            res.end();
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
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          })}\n\n`,
        );
      },
      () => {
        if (midUpgrade) return;
        logTrafficResponse(
          config.verbose,
          model ?? cursorModel,
          accumulated,
          true,
        );
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        const completionTokens = Math.max(
          1,
          Math.round(accumulated.length / 4),
        );
        commitSse();
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
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
            writeChatSseError(
              res,
              "Cold ACP spawn capacity exceeded; retry shortly",
              "cold_spawn_capacity",
            );
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

  latency.mark("exec_start");
  latency.mark("account_select_start");

  const abortController = new AbortController();
  req.once("close", () => abortController.abort());

  let configDir: string | undefined;
  let out!: Awaited<ReturnType<typeof runAgentSync>>;
  let syncLatency = 0;
  let lastSignal: ReturnType<typeof applyAgentAccountSignals> = "other";

  for (let attempts = 0; attempts < 2; attempts++) {
    configDir = getNextAccountConfigDirForModel(cursorModel);
    if (attempts === 0) latency.mark("account_select_end");
    if (isAllAccountsDisabled(configDir)) {
      latency.mark("shape_done");
      latency.logLine({ ok: false, model: displayModel });
      rejectNoUsableAccounts(res);
      return;
    }
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const syncStart = Date.now();

    latency.mark("spawn_start");
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
    latency.mergeAgentMarks(out.latencyMarks);
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
    latency.mark("shape_done");
    latency.logLine({ ok: false, model: displayModel });
    rejectColdSpawnCapacity(res, out.retryAfterMs, {
      ...truncatedHeaders,
      ...poolHeaders,
      "X-Cursor-Proxy-Waterfall": latency.headerValue(),
    });
    return;
  }

  if (lastSignal === "plan_upgrade") {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    latency.mark("shape_done");
    latency.logLine({ ok: false, model: displayModel });
    if (getAccountStats().length > 0 && getUsableCount() === 0) {
      rejectNoUsableAccounts(res);
      return;
    }
    json(
      res,
      500,
      {
        error: {
          message: "Cursor account plan upgrade required",
          code: "account_plan_upgrade",
        },
      },
      {
        ...truncatedHeaders,
        ...poolHeaders,
        "X-Cursor-Proxy-Waterfall": latency.headerValue(),
      },
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
    latency.mark("shape_done");
    latency.logLine({ ok: false, model: displayModel });
    json(
      res,
      500,
      {
        error: { message: errMsg, code: "cursor_cli_error" },
      },
      {
        ...truncatedHeaders,
        ...poolHeaders,
        "X-Cursor-Proxy-Waterfall": latency.headerValue(),
      },
    );
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  if (!latency.has("model_complete")) {
    latency.mark("model_complete");
  }
  const content = out.stdout.trim();
  maybeWarnThoughtOnly(content, out.reasoning);
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const usage = usageFor(agentPrompt, content);
  const resolved = toolBridgeActive
    ? resolveAssistantOutput(content, body.tools, {
        toolChoice: body.tool_choice,
      })
    : { kind: "text" as const, content };
  if (
    toolBridgeActive &&
    resolved.kind === "text" &&
    containsToolCallCandidate(content)
  ) {
    console.warn(
      `[tool-calls] rejected model tool output for ${displayModel ?? "default"}`,
    );
  }
  const baseMessage =
    resolved.kind === "tool_call"
      ? { role: "assistant", content: null, tool_calls: [resolved.toolCall] }
      : { role: "assistant", content: resolved.content };
  const message = withReasoningContent(
    baseMessage,
    out.reasoning,
    config.thoughtMode,
  );
  const finishReason =
    resolved.kind === "tool_call" ? "tool_calls" : "stop";

  latency.mark("shape_done");
  latency.logLine({
    ok: true,
    model: displayModel,
    pool_hit: !!out.poolHit,
    prompt_dispatch_ms:
      out.latencyMarks?.prompt_dispatched != null &&
      out.latencyMarks?.prompt_dispatch_start != null
        ? Math.round(
            (out.latencyMarks.prompt_dispatched -
              out.latencyMarks.prompt_dispatch_start) *
              10,
          ) / 10
        : undefined,
  });
  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: displayModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    },
    {
      ...truncatedHeaders,
      ...poolHeaders,
      "X-Cursor-Proxy-Waterfall": latency.headerValue(),
    },
  );
}
