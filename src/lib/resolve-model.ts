import type { BridgeConfig } from "./config.js";

const FAST_ALIASES = new Set(["cursor-fast", "fast"]);

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
): string {
  const isDefault = requested === "default";
  const explicitModel = requested && !isDefault ? requested : undefined;

  // "default" matches ACP catalog name for session default model — pass through directly
  if (isDefault) return "default";

  if (explicitModel) {
    if (normalizeFastAlias(explicitModel)) {
      return config.cursorFastModel;
    }
    return explicitModel;
  }

  if (config.stickyModel && lastRequestedModelRef.current) {
    return lastRequestedModelRef.current;
  }

  return config.defaultModel;
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
