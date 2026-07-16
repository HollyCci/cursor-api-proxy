export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  messages: any[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  functions?: any[];
  function_call?: any;
};

export function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function imageUrlToText(imageUrl: any): string {
  if (!imageUrl) return "[Image]";
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : "";
  if (!url) return "[Image]";
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";")) || "image";
    return `[Image: base64 ${mime}]`;
  }
  return `[Image: ${url}]`;
}

function messageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "image_url") return imageUrlToText(p.image_url);
        if (p.type === "image") return imageUrlToText(p.source?.url ?? p.url ?? p.source);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Serialise tool/function schemas into a text block for the system prompt.
 * This allows the model to be aware of available tools even though we can't
 * return tool_call deltas natively.
 */
export function toolsToSystemText(
  tools?: any[],
  functions?: any[],
): string | undefined {
  const defs: any[] = [];

  if (tools && tools.length > 0) {
    for (const t of tools) {
      const fn = t?.type === "function" ? t.function : t;
      if (fn) defs.push(fn);
    }
  }
  if (functions && functions.length > 0) {
    defs.push(...functions);
  }

  if (defs.length === 0) return undefined;

  const lines = [
    "Available tools (respond with a JSON object to call one):",
    "",
    ...defs.map((fn) => {
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : "{}";
      return `Function: ${fn.name}\nDescription: ${fn.description ?? ""}\nParameters: ${params}`;
    }),
  ];
  return lines.join("\n");
}

export function buildPromptFromMessages(messages: any[]): string {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m?.role;
    const text = messageContentToText(m?.content);

    if (role === "assistant" && Array.isArray(m?.tool_calls)) {
      if (text) convo.push(`Assistant: ${text}`);
      for (const call of m.tool_calls) {
        const name = call?.function?.name;
        const args = call?.function?.arguments;
        if (typeof name !== "string") continue;
        const id =
          typeof call?.id === "string" && call.id ? ` (${call.id})` : "";
        convo.push(
          `Assistant requested tool ${name}${id} with arguments: ${
            typeof args === "string" ? args : JSON.stringify(args ?? {})
          }`,
        );
      }
      continue;
    }

    if (role === "tool") {
      if (!text) continue;
      const name =
        typeof m?.name === "string" && m.name ? ` ${m.name}` : "";
      const id =
        typeof m?.tool_call_id === "string" && m.tool_call_id
          ? ` (${m.tool_call_id})`
          : "";
      convo.push(
        name || id ? `Tool result for${name}${id}: ${text}` : `Tool: ${text}`,
      );
      continue;
    }

    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
      continue;
    }
    if (role === "function") {
      convo.push(`Tool: ${text}`);
      continue;
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  return system + transcript + "\n\nAssistant:";
}
