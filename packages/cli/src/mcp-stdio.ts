/**
 * Official MCP stdio is one compact JSON-RPC object per line (no Content-Length).
 * Cursor's Windows host reads line-delimited JSON; LSP-style headers left Local
 * on Connecting… forever (RAD-82) because the JSON body had no trailing newline.
 */

/** Written to stderr on listen so Output → MCP Logs proves Cursor spawned us. */
export const MCP_STDIO_READY = "[prgenie] mcp stdio ready";

export function encodeMcpFrame(msg: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(msg)}\n`, "utf8");
}

function headerEnd(buffer: Buffer): number {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) return crlf + 4;
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) return lf + 2;
  return -1;
}

function contentLengthOf(headers: string): number | null {
  const match = headers.match(/^content-length:\s*(\d+)\s*$/im);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Pull complete JSON-RPC messages off a byte buffer.
 * Official clients send NDJSON; still accept Content-Length from older hosts.
 */
export function takeMcpMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let rest = buffer;

  while (rest.length > 0) {
    const trimmedStart = rest.findIndex(
      (b) => b !== 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0a,
    );
    if (trimmedStart > 0) rest = rest.subarray(trimmedStart);
    if (rest.length === 0) break;

    const asStart = rest.toString("ascii", 0, Math.min(rest.length, 64));
    if (/^content-length:/i.test(asStart) || /^content-type:/i.test(asStart)) {
      const end = headerEnd(rest);
      if (end === -1) break;
      const headers = rest.subarray(0, end).toString("ascii");
      const length = contentLengthOf(headers);
      if (length === null) {
        rest = rest.subarray(end);
        continue;
      }
      if (rest.length < end + length) break;
      const body = rest.subarray(end, end + length);
      rest = rest.subarray(end + length);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        // skip malformed frame
      }
      continue;
    }

    if (rest[0] === 0x7b /* { */) {
      const nl = rest.indexOf(0x0a);
      if (nl !== -1) {
        const line = rest.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
        rest = rest.subarray(nl + 1);
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          // skip malformed NDJSON line
        }
        continue;
      }
      const complete = takeCompleteJsonObject(rest);
      if (!complete) break;
      messages.push(complete.value);
      rest = complete.rest;
      continue;
    }

    const nl = rest.indexOf(0x0a);
    if (nl === -1) break;
    rest = rest.subarray(nl + 1);
  }

  return { messages, rest };
}

/** Cursor may write initialize without a trailing newline. Brace-match one object. */
export function takeCompleteJsonObject(buffer: Buffer): { value: unknown; rest: Buffer } | null {
  if (buffer.length === 0 || buffer[0] !== 0x7b) return null;
  const text = buffer.toString("utf8");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(0, i + 1);
        try {
          return {
            value: JSON.parse(slice),
            rest: buffer.subarray(Buffer.byteLength(slice, "utf8")),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
