import type http from "node:http";

/** Max JSON/MCP body size accepted by the runner HTTP server. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /\b(sk|rk)_[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /"(?:apiKey|token|password|authorization)"\s*:\s*"[^"]+"/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (m.length > 24 ? `${m.slice(0, 8)}…[redacted]` : "[redacted]"));
  }
  return out;
}

export type BoundedBodyResult =
  { ok: true; text: string } | { ok: false; status: 413; error: string };

export function readBoundedBody(
  req: http.IncomingMessage,
  maxBytes = MAX_HTTP_BODY_BYTES,
): Promise<BoundedBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        resolve({ ok: false, status: 413, error: "request body too large" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", reject);
  });
}

export type JsonParseResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export function parseJsonBody(body: string): JsonParseResult {
  if (!body.trim()) {
    return { ok: false, error: "empty body" };
  }
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}

export function parseJsonObject(body: string): JsonParseResult<Record<string, unknown>> {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return parsed;
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, error: "expected json object" };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

export class HttpResponseGuard {
  started = false;
  constructor(private readonly res: http.ServerResponse) {}

  json(status: number, payload: unknown): void {
    if (this.started) return;
    this.started = true;
    const body = JSON.stringify(payload);
    this.res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    this.res.end(body);
  }

  text(status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(status, { "Content-Type": contentType });
    this.res.end(body);
  }

  html(status: number, body: string): void {
    this.text(status, body, "text/html; charset=utf-8");
  }

  /** Start SSE or other streaming response (marks headers sent). */
  begin(headers: Record<string, string | number | string[]>): void {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, headers);
  }
}

export function safeHandlerMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).slice(0, 500);
}
