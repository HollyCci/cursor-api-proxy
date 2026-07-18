/**
 * Maps Anthropic/Claude Code model names to Cursor CLI model IDs
 * so clients like Claude Code can send "claude-opus-4-6" and the proxy uses "opus-4.6".
 */

import type { ModelLane } from "./resolve-model.js";

export type ModelResolutionDecision = {
  requested?: string;
  mapped?: string;
  final: string;
  requestedWasDefault: boolean;
  validated: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
  lane?: ModelLane;
  /** False only for fail-closed fast lane failures. */
  ok: boolean;
  error?: "cursor_fast_unavailable";
};

/** Anthropic-style model name (any case) -> Cursor CLI model id */
const ANTHROPIC_TO_CURSOR: Record<string, string> = {
  // Claude 4.6
  "claude-opus-4-6": "opus-4.6",
  "claude-opus-4.6": "opus-4.6",
  "claude-sonnet-4-6": "sonnet-4.6",
  "claude-sonnet-4.6": "sonnet-4.6",
  // Claude 4.5
  "claude-opus-4-5": "opus-4.5",
  "claude-opus-4.5": "opus-4.5",
  "claude-sonnet-4-5": "sonnet-4.5",
  "claude-sonnet-4.5": "sonnet-4.5",
  // Generic 4.x (prefer 4.6)
  "claude-opus-4": "opus-4.6",
  "claude-sonnet-4": "sonnet-4.6",
  // Haiku (Cursor has no Haiku; map to Sonnet)
  "claude-haiku-4-5-20251001": "sonnet-4.5",
  "claude-haiku-4-5": "sonnet-4.5",
  "claude-haiku-4-6": "sonnet-4.6",
  "claude-haiku-4": "sonnet-4.5",
  // Thinking variants (if client sends them)
  "claude-opus-4-6-thinking": "opus-4.6-thinking",
  "claude-sonnet-4-6-thinking": "sonnet-4.6-thinking",
  "claude-opus-4-5-thinking": "opus-4.5-thinking",
  "claude-sonnet-4-5-thinking": "sonnet-4.5-thinking",
};

/** Cursor IDs we want to expose under Anthropic-style names in GET /v1/models */
const CURSOR_TO_ANTHROPIC_ALIAS: Array<{ cursorId: string; anthropicId: string; name: string }> = [
  { cursorId: "opus-4.6", anthropicId: "claude-opus-4-6", name: "Claude 4.6 Opus" },
  { cursorId: "opus-4.6-thinking", anthropicId: "claude-opus-4-6-thinking", name: "Claude 4.6 Opus (Thinking)" },
  { cursorId: "sonnet-4.6", anthropicId: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet" },
  { cursorId: "sonnet-4.6-thinking", anthropicId: "claude-sonnet-4-6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
  { cursorId: "opus-4.5", anthropicId: "claude-opus-4-5", name: "Claude 4.5 Opus" },
  { cursorId: "opus-4.5-thinking", anthropicId: "claude-opus-4-5-thinking", name: "Claude 4.5 Opus (Thinking)" },
  { cursorId: "sonnet-4.5", anthropicId: "claude-sonnet-4-5", name: "Claude 4.5 Sonnet" },
  { cursorId: "sonnet-4.5-thinking", anthropicId: "claude-sonnet-4-5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
];

function normalizeForLookup(value: string): string {
  return value.trim().toLowerCase();
}

function mapClaudeDatedVariant(key: string): string | undefined {
  const trimmed = key.trim().toLowerCase();
  const simplified = trimmed.replace(/-v\d+$/i, "");
  const match = simplified.match(
    /^claude-(opus|sonnet|haiku)-4(?:[.-](5|6))?(?:-thinking)?(?:-\d{8})?$/,
  );
  if (!match) return undefined;

  const family = match[1];
  const version = match[2];
  const isThinking = simplified.includes("-thinking");

  const normalizedFamily = family === "haiku" ? "sonnet" : family;
  const normalizedVersion = version ?? "6";
  const suffix = isThinking ? "-thinking" : "";
  return `${normalizedFamily}-4.${normalizedVersion}${suffix}`;
}

/**
 * Resolve a requested model (e.g. from the client) to the Cursor CLI model ID.
 * If the request uses an Anthropic-style name, returns the mapped Cursor ID; otherwise returns the value as-is.
 */
export function resolveToCursorModel(requested: string | undefined): string | undefined {
  if (!requested || !requested.trim()) return undefined;
  const key = normalizeForLookup(requested);
  return ANTHROPIC_TO_CURSOR[key] ?? mapClaudeDatedVariant(key) ?? requested.trim();
}

function matchAvailableModel(
  candidate: string | undefined,
  availableCursorIds: string[],
): string | undefined {
  if (!candidate) return undefined;
  const byLower = new Map(availableCursorIds.map((id) => [id.toLowerCase(), id]));
  return byLower.get(candidate.toLowerCase());
}

function fastUnavailable(
  partial: Omit<ModelResolutionDecision, "ok" | "error" | "fallbackUsed" | "validated"> & {
    fallbackUsed?: boolean;
    validated?: boolean;
  },
): ModelResolutionDecision {
  return {
    ...partial,
    validated: false,
    fallbackUsed: false,
    ok: false,
    error: "cursor_fast_unavailable",
  };
}

export function resolveModelForExecution(args: {
  requested: string | undefined;
  defaultModel: string;
  availableCursorIds: string[];
  /** When "fast", never fall back to another model. */
  lane?: ModelLane;
}): ModelResolutionDecision {
  const lane = args.lane;
  const requested = args.requested?.trim();
  const requestedWasDefault = requested === "default";
  const mapped = requestedWasDefault
    ? "default"
    : resolveToCursorModel(requested) ?? args.defaultModel;

  if (lane === "fast") {
    if (mapped === "default") {
      return fastUnavailable({
        requested,
        mapped,
        final: mapped,
        requestedWasDefault,
        lane,
      });
    }
    if (!args.availableCursorIds.length) {
      return fastUnavailable({
        requested,
        mapped,
        final: mapped,
        requestedWasDefault,
        lane,
        fallbackReason: "catalog_unavailable",
      });
    }
    const matched = matchAvailableModel(mapped, args.availableCursorIds);
    if (!matched) {
      return fastUnavailable({
        requested,
        mapped,
        final: mapped,
        requestedWasDefault,
        lane,
        fallbackReason: "mapped_model_unavailable",
      });
    }
    return {
      requested,
      mapped,
      final: matched,
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
      lane,
      ok: true,
    };
  }

  if (mapped === "default") {
    return {
      requested,
      mapped,
      final: "default",
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
      lane,
      ok: true,
    };
  }

  const matchedMapped = matchAvailableModel(mapped, args.availableCursorIds);
  if (matchedMapped) {
    return {
      requested,
      mapped,
      final: matchedMapped,
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
      lane,
      ok: true,
    };
  }

  const matchedDefault = matchAvailableModel(args.defaultModel, args.availableCursorIds);
  if (matchedDefault) {
    return {
      requested,
      mapped,
      final: matchedDefault,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
      lane,
      ok: true,
    };
  }

  const matchedAuto = matchAvailableModel("auto", args.availableCursorIds);
  if (matchedAuto) {
    return {
      requested,
      mapped,
      final: matchedAuto,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
      lane,
      ok: true,
    };
  }

  const firstAvailable = args.availableCursorIds[0];
  if (firstAvailable) {
    return {
      requested,
      mapped,
      final: firstAvailable,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
      lane,
      ok: true,
    };
  }

  return {
    requested,
    mapped,
    final: mapped,
    requestedWasDefault,
    validated: false,
    fallbackUsed: false,
    fallbackReason: "catalog_unavailable",
    lane,
    ok: true,
  };
}

/**
 * Return extra model list entries for GET /v1/models so clients like Claude Code
 * see Anthropic-style ids (e.g. claude-opus-4-6) when those Cursor models are available.
 */
export function getAnthropicModelAliases(availableCursorIds: string[]): Array<{ id: string; name: string }> {
  const set = new Set(availableCursorIds);
  return CURSOR_TO_ANTHROPIC_ALIAS
    .filter((a) => set.has(a.cursorId))
    .map((a) => ({ id: a.anthropicId, name: a.name }));
}
