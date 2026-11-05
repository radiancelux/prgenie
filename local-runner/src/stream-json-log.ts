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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type AgentLogBlock =
  | { kind: "banner"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "prose"; text: string }
  | {
      kind: "tool";
      name: string;
      summary: string;
      detail: string;
      phase: "started" | "failed";
      error?: string;
    }
  | { kind: "plain"; text: string }
  | { kind: "error"; text: string };

export function parseAgentLogBlocks(raw: string): AgentLogBlock[] | null {
  if (!raw.trim()) return [];
  if (!looksLikeStreamJsonLog(raw)) return null;

  const blocks: AgentLogBlock[] = [];
  let thinkingBuf = "";

  const flushThinking = () => {
    const text = thinkingBuf.trim();
    thinkingBuf = "";
    if (text) blocks.push({ kind: "thinking", text });
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("--- agent")) {
      flushThinking();
      blocks.push({ kind: "banner", text: trimmed });
      continue;
    }

    if (!trimmed.startsWith("{")) {
      flushThinking();
      blocks.push({ kind: "plain", text: trimmed });
      continue;
    }

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      flushThinking();
      blocks.push({ kind: "plain", text: trimmed });
      continue;
    }

    const type = String(ev.type ?? "");
    const subtype = String(ev.subtype ?? "");

    if (type === "system" && subtype === "init") {
      flushThinking();
      const model = ev.model ? String(ev.model) : "agent";
      blocks.push({ kind: "meta", text: `Started ${model}` });
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
      if (text) blocks.push({ kind: "prose", text });
      continue;
    }

    if (type === "tool_call") {
      const tc = ev.tool_call as Record<string, unknown> | undefined;
      if (!tc) continue;
      const { kind, args, result } = toolPayload(tc);
      const name = kind ?? "tool";
      const argSummary = summarizeToolArgs(kind, args);
      const detail = toolDetailLine(kind, args);
      if (subtype === "started") {
        flushThinking();
        blocks.push({
          kind: "tool",
          name,
          summary: argSummary,
          detail,
          phase: "started",
        });
        continue;
      }
      if (subtype === "completed") {
        const err = formatToolError(result);
        if (err) {
          blocks.push({
            kind: "tool",
            name,
            summary: argSummary,
            detail,
            phase: "failed",
            error: err,
          });
        }
      }
      continue;
    }

    if (type === "error" || subtype === "error") {
      flushThinking();
      const msg = ev.message ?? ev.error ?? ev.text;
      blocks.push({ kind: "error", text: truncate(String(msg ?? "Agent error"), 300) });
    }
  }

  flushThinking();
  return blocks;
}

function toolDetailLine(kind: string | null, args: Record<string, unknown>): string {
  if (kind === "shell" && args.command) return String(args.command);
  if (
    (kind === "read" || kind === "edit" || kind === "write" || kind === "strReplace") &&
    args.path
  ) {
    return String(args.path);
  }
  if (kind === "grep") {
    const pattern = args.pattern != null ? String(args.pattern) : "";
    const inPath = args.path ? ` in ${String(args.path)}` : "";
    return pattern + inPath;
  }
  if (!args || !Object.keys(args).length) return "";
  return truncate(JSON.stringify(args, null, 0), 400);
}

export function formatAgentLogTail(raw: string): string {
  const blocks = parseAgentLogBlocks(raw);
  if (blocks === null) return raw;
  if (!blocks.length) return "";

  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "banner":
        lines.push(b.text);
        break;
      case "meta":
        lines.push(`▸ ${b.text}`);
        break;
      case "thinking":
        lines.push(`💭 ${truncate(b.text, 300)}`);
        break;
      case "prose":
        lines.push(b.text);
        break;
      case "tool":
        if (b.phase === "failed") lines.push(`✗ ${b.name} failed: ${b.error ?? "error"}`);
        else lines.push(b.summary ? `⚙ ${b.name} — ${b.summary}` : `⚙ ${b.name}`);
        break;
      case "plain":
        lines.push(b.text);
        break;
      case "error":
        lines.push(`✗ ${b.text}`);
        break;
    }
  }
  return lines.join("\n\n");
}

export function formatAgentLogTailHtml(raw: string): string {
  const blocks = parseAgentLogBlocks(raw);
  if (blocks === null) {
    return `<pre class="agent-pass-through">${escapeHtml(raw)}</pre>`;
  }
  if (!blocks.length) return "";

  const parts: string[] = [];
  let turnOpen = false;
  const closeTurn = () => {
    if (turnOpen) {
      parts.push("</div>");
      turnOpen = false;
    }
  };

  for (const b of blocks) {
    switch (b.kind) {
      case "banner":
        closeTurn();
        parts.push(`<div class="agent-turn"><div class="agent-banner">${escapeHtml(b.text)}</div>`);
        turnOpen = true;
        break;
      case "meta":
        parts.push(`<div class="agent-meta">${escapeHtml(b.text)}</div>`);
        break;
      case "thinking":
        parts.push(
          `<div class="agent-thinking"><span class="agent-thinking-label">Thinking</span> ${escapeHtml(truncate(b.text, 500))}</div>`,
        );
        break;
      case "prose":
        parts.push(`<div class="agent-prose">${formatProseHtml(b.text)}</div>`);
        break;
      case "tool": {
        const chip = escapeHtml(b.name);
        const summary = b.summary
          ? `<span class="agent-tool-summary">${escapeHtml(b.summary)}</span>`
          : "";
        if (b.phase === "failed") {
          parts.push(
            `<div class="agent-tool agent-tool-failed"><div class="agent-tool-head"><span class="agent-tool-chip">${chip}</span>${summary}</div><div class="agent-tool-error">${escapeHtml(b.error ?? "failed")}</div></div>`,
          );
        } else {
          parts.push(
            `<div class="agent-tool"><div class="agent-tool-head"><span class="agent-tool-chip">${chip}</span>${summary}</div></div>`,
          );
        }
        break;
      }
      case "plain":
        parts.push(`<div class="agent-plain">${escapeHtml(b.text)}</div>`);
        break;
      case "error":
        parts.push(`<div class="agent-error">${escapeHtml(b.text)}</div>`);
        break;
    }
  }
  closeTurn();
  return parts.join("\n");
}

function formatProseHtml(text: string): string {
  const paras = text.split(/\n{2,}/);
  return paras
    .map((p) => {
      const inner = escapeHtml(p.trim()).replace(/\n/g, "<br />");
      return inner ? `<p>${inner}</p>` : "";
    })
    .filter(Boolean)
    .join("");
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
    escapeHtml,
    toolDetailLine,
    formatProseHtml,
    parseAgentLogBlocks,
    formatAgentLogTail,
    formatAgentLogTailHtml,
  ];
  return `(function() {
const __name = (fn) => fn;
${fns.map((fn) => fn.toString()).join("\n")}
return { formatAgentLogTail, formatAgentLogTailHtml, looksLikeStreamJsonLog };
})()`;
}
