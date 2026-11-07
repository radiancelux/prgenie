/** Stderr ready line hosts grep for smoke tests (stdout is MCP-only). */
export const MCP_STDIO_READY = "[prgenie] mcp stdio ready";

/** NDJSON MCP framing (matches PR Genie CLI host expectations). */

type StdioReply = { jsonrpc: "2.0"; id: string | number | null } & Record<string, unknown>;

/**
 * Pump framed JSON-RPC from `input` through `handle`, writing one NDJSON frame per reply.
 * Resolves once `input` ends and every in-flight request has been answered.
 */
export function serveMcpStdio(
  input: NodeJS.ReadableStream,
  write: (frame: Buffer) => void,
  handle: (msg: unknown) => Promise<StdioReply | null>,
): Promise<void> {
  let buffer: Buffer = Buffer.alloc(0);
  const pending = new Set<Promise<void>>();
  const reply = (msg: StdioReply) => write(encodeMcpFrame(msg));

  const dispatch = async (msg: unknown) => {
    const id = (msg as { id?: unknown } | null)?.id;
    const echoId = typeof id === "string" || typeof id === "number" ? id : null;
    try {
      const res = await handle(msg);
      if (res) reply(res);
    } catch (err) {
      if (id === undefined) return;
      reply({
        jsonrpc: "2.0",
        id: echoId,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  return new Promise((resolve) => {
    input.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = Buffer.concat([buffer, bytes]) as Buffer;
      const { messages, rest, parseErrors } = takeMcpMessages(buffer);
      buffer = rest;
      for (let i = 0; i < parseErrors; i++) {
        reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      for (const msg of messages) {
        const p = dispatch(msg).finally(() => pending.delete(p));
        pending.add(p);
      }
    });
    input.on("end", () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}

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

export function takeMcpMessages(buffer: Buffer): {
  messages: unknown[];
  rest: Buffer;
  parseErrors: number;
} {
  const messages: unknown[] = [];
  let parseErrors = 0;
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
        parseErrors++;
      }
      continue;
    }

    if (rest[0] === 0x7b) {
      const nl = rest.indexOf(0x0a);
      if (nl !== -1) {
        const line = rest.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
        rest = rest.subarray(nl + 1);
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          parseErrors++;
        }
        continue;
      }
      break;
    }

    const nl = rest.indexOf(0x0a);
    if (nl === -1) break;
    rest = rest.subarray(nl + 1);
  }

  return { messages, rest, parseErrors };
}
