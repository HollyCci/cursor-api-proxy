import type { BridgeConfig } from "./config.js";

const FAST_ALIASES = new Set(["cursor-fast", "fast"]);

export type ModelLane = "fast" | "explicit" | "default" | "sticky";

export type ResolvedModelRequest = {
  /** Canonical model id to execute / validate (never a bare fast alias). */
  model: string;
  /** Request intent; fast lane must stay fail-closed even after alias expand. */
  lane: ModelLane;
};

function normalizeFastAlias(requested: string): string | undefined {
  const key = requested.trim().toLowerCase();
  return FAST_ALIASES.has(key) ? key : undefined;
}

/**
 * Resolve the requested model (already normalized) to the final model string,
 * applying cursor-fast aliases and optional sticky lastRequestedModelRef.
 */
export function resolveModel(
  requested: string | undefined,
  lastRequestedModelRef: { current?: string },
  config: BridgeConfig,
): ResolvedModelRequest {
  const isDefault = requested === "default";
  const explicitModel = requested && !isDefault ? requested : undefined;

  // "default" matches ACP catalog name for session default model — pass through directly
  if (isDefault) return { model: "default", lane: "default" };

  if (explicitModel) {
    if (normalizeFastAlias(explicitModel)) {
      return { model: config.cursorFastModel, lane: "fast" };
    }
    return { model: explicitModel, lane: "explicit" };
  }

  if (config.stickyModel && lastRequestedModelRef.current) {
    return { model: lastRequestedModelRef.current, lane: "sticky" };
  }

  return { model: config.defaultModel, lane: "default" };
}

/**
 * Persist only the final model used for execution.
 */
export function rememberResolvedModel(
  model: string,
  lastRequestedModelRef: { current?: string },
): void {
  if (!model || model === "default") return;
  lastRequestedModelRef.current = model;
}
