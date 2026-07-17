/**
 * ACP thought-channel policy helpers.
 * Thought never mixes into OpenAI `content`; optional map to `reasoning_content`.
 */

export type ThoughtMode = "drop" | "reasoning";

/** Attach reasoning_content only when mode is reasoning and text is non-empty. */
export function withReasoningContent<T extends Record<string, unknown>>(
  message: T,
  reasoning: string | undefined,
  mode: ThoughtMode,
): T {
  if (mode !== "reasoning") return message;
  const text = reasoning?.trim();
  if (!text) return message;
  return { ...message, reasoning_content: text };
}

/** SSE delta for a thought chunk (or null when dropped). */
export function thoughtStreamDelta(
  text: string,
  mode: ThoughtMode,
): { reasoning_content: string } | null {
  if (mode !== "reasoning") return null;
  if (!text) return null;
  return { reasoning_content: text };
}
