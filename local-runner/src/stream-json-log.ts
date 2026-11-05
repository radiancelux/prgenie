/** Parse cursor-agent `--output-format stream-json` log tails into readable steps. */

export function truncate(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function shortPath(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split(/[/\\]/);
  return parts.length <= 3 ? filePath : `…/${parts.slice(-2).join("/")}`;
}

export function toolCallKind(toolCall: Record<string, unknown>): string | null {
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith("ToolCall") && key !== "toolCallId") {
      return key.replace(/ToolCall$/, "");
    }
  }
  return null;
}

export function summarizeToolArgs(kind: string | null, args: Record<string, unknown>): string {
  if (!args) return "";
  switch (kind) {
    case "read":
      return shortPath(String(args.path ?? ""));
    case "grep":
      return (
        truncate(String(args.pattern ?? ""), 80) +
        (args.path ? ` in ${shortPath(String(args.path))}` : "")
      );
    case "glob":
      return String(args.globPattern ?? args.pattern ?? "");
    case "shell":
      return truncate(String(args.command ?? args.description ?? ""), 120);
    case "edit":
    case "write":
    case "strReplace":
      return shortPath(String(args.path ?? ""));
    default: {
      const keys = ["path", "command", "pattern", "globPattern", "query", "description"];
      for (const k of keys) {
        if (args[k] != null && args[k] !== "") return truncate(String(args[k]), 120);
      }
      return truncate(JSON.stringify(args), 100);
    }
  }
}

export function toolPayload(toolCall: Record<string, unknown>): {
  kind: string | null;
  args: Record<string, unknown>;
  result: unknown;
} {
  const kind = toolCallKind(toolCall);
  if (!kind) return { kind: null, args: {}, result: undefined };
  const inner = toolCall[`${kind}ToolCall`] as Record<string, unknown> | undefined;
  return {
    kind,
    args: (inner?.args as Record<string, unknown>) ?? {},
    result: inner?.result,
  };
}

export function formatToolError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.error && typeof r.error === "object") {
    const err = r.error as Record<string, unknown>;
    const msg = err.modelVisibleError ?? err.error ?? err.message;
    if (msg) return truncate(String(msg), 200);
  }
  return null;
}

export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .join("");
}

export function looksLikeStreamJsonLog(raw: string): boolean {
  if (/--- agent \([^)]+,\s*stream-json\)\s*---/.test(raw)) return true;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as { type?: string };
      if (ev.type === "assistant" || ev.type === "tool_call" || ev.type === "thinking") return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function formatAgentLogTail(raw: string): string {
  if (!raw.trim()) return "";
  if (!looksLikeStreamJsonLog(raw)) return raw;

  const steps: string[] = [];
  let thinkingBuf = "";

  const flushThinking = () => {
    const text = thinkingBuf.trim();
    thinkingBuf = "";
    if (text) steps.push(`💭 ${truncate(text, 300)}`);
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("--- agent")) {
      flushThinking();
      steps.push(trimmed);
      continue;
    }

    if (!trimmed.startsWith("{")) {
      flushThinking();
      steps.push(trimmed);
      continue;
    }

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      flushThinking();
      steps.push(trimmed);
      continue;
    }

    const type = String(ev.type ?? "");
    const subtype = String(ev.subtype ?? "");

    if (type === "system" && subtype === "init") {
      flushThinking();
      const model = ev.model ? String(ev.model) : "agent";
      steps.push(`▸ Started ${model}`);
      continue;
    }

    if (type === "user") continue;

    if (type === "thinking") {
      if (subtype === "delta" && typeof ev.text === "string") thinkingBuf += ev.text;
      if (subtype === "completed") flushThinking();
      continue;
    }

    if (type === "assistant") {
      flushThinking();
      const text = assistantText(ev.message).trim();
      if (text) steps.push(text);
      continue;
    }

    if (type === "tool_call") {
      const tc = ev.tool_call as Record<string, unknown> | undefined;
      if (!tc) continue;
      const { kind, args, result } = toolPayload(tc);
      const name = kind ?? "tool";
      if (subtype === "started") {
        flushThinking();
        const argSummary = summarizeToolArgs(kind, args);
        steps.push(argSummary ? `⚙ ${name} — ${argSummary}` : `⚙ ${name}`);
        continue;
      }
      if (subtype === "completed") {
        const err = formatToolError(result);
        if (err) steps.push(`✗ ${name} failed: ${err}`);
      }
      continue;
    }

    if (type === "error" || subtype === "error") {
      flushThinking();
      const msg = ev.message ?? ev.error ?? ev.text;
      steps.push(`✗ ${truncate(String(msg ?? "Agent error"), 300)}`);
    }
  }

  flushThinking();
  return steps.join("\n\n");
}

/** Browser-side helpers injected into the runner UI (same logic as this module). */
export function streamJsonLogBrowserScript(): string {
  const fns = [
    truncate,
    shortPath,
    toolCallKind,
    summarizeToolArgs,
    toolPayload,
    formatToolError,
    assistantText,
    looksLikeStreamJsonLog,
    formatAgentLogTail,
  ];
  return `(function() {
const __name = (fn) => fn;
${fns.map((fn) => fn.toString()).join("\n")}
return { formatAgentLogTail, looksLikeStreamJsonLog };
})()`;
}
