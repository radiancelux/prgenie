import { readFile } from "node:fs/promises";
import type { TokenUsage } from "./types.js";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageFromRecord(raw: Record<string, unknown>): Partial<TokenUsage> | null {
  const input = num(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens);
  const output = num(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens);
  const cacheRead = num(
    raw.cacheReadInputTokens ?? raw.cache_read_input_tokens ?? raw.cacheRead ?? raw.cache_read,
  );
  const cacheWrite = num(
    raw.cacheCreationInputTokens ??
      raw.cache_creation_input_tokens ??
      raw.cacheWrite ??
      raw.cache_write,
  );
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

/** Parse one stream-json log line for agent usage (typically on `type: result`). */
export function parseUsageFromStreamJsonLine(line: string): Partial<TokenUsage> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  if (o.usage && typeof o.usage === "object") {
    return usageFromRecord(o.usage as Record<string, unknown>);
  }

  if (o.type === "result") {
    if (o.result && typeof o.result === "object") {
      const inner = o.result as Record<string, unknown>;
      if (inner.usage && typeof inner.usage === "object") {
        return usageFromRecord(inner.usage as Record<string, unknown>);
      }
    }
    return usageFromRecord(o);
  }

  return null;
}

export function sumTokenUsages(partials: Partial<TokenUsage>[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const p of partials) {
    input += p.input ?? 0;
    output += p.output ?? 0;
    cacheRead += p.cacheRead ?? 0;
    cacheWrite += p.cacheWrite ?? 0;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

export function parseTokenUsageFromLogContent(content: string): TokenUsage | null {
  const partials: Partial<TokenUsage>[] = [];
  for (const line of content.split(/\n/)) {
    const parsed = parseUsageFromStreamJsonLine(line);
    if (parsed) partials.push(parsed);
  }
  if (partials.length === 0) return null;
  return sumTokenUsages(partials);
}

export async function sumTokenUsageFromLog(logPath: string): Promise<TokenUsage | null> {
  try {
    const content = await readFile(logPath, "utf8");
    return parseTokenUsageFromLogContent(content);
  } catch {
    return null;
  }
}
