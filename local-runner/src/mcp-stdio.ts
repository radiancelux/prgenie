/** NDJSON MCP framing (matches PR Genie CLI host expectations). */

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
        // skip
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
          // skip
        }
        continue;
      }
      break;
    }

    const nl = rest.indexOf(0x0a);
    if (nl === -1) break;
    rest = rest.subarray(nl + 1);
  }

  return { messages, rest };
}
