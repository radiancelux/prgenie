import path from "node:path";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export type HookStdinReadResult = {
  raw: Buffer;
  readError: string | null;
};

export type HookPayloadParseResult =
  { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

/** Strip a leading UTF-8 BOM (Cursor Windows hook delivery, RAD-185). */
export function stripUtf8BomBuffer(buf: Buffer): Buffer {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) {
    return buf.subarray(3);
  }
  return buf;
}

export function stripUtf8BomString(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseHookPayloadBuffer(raw: Buffer): HookPayloadParseResult {
  if (raw.length === 0) {
    return { ok: false, reason: "PR Genie gate received no input" };
  }
  const body = stripUtf8BomBuffer(raw);
  if (body.length === 0) {
    return { ok: false, reason: "PR Genie gate received no input" };
  }
  let text: string;
  try {
    text = body.toString("utf8");
  } catch {
    return { ok: false, reason: "PR Genie gate received unparseable hook input" };
  }
  return parseHookPayloadText(stripUtf8BomString(text));
}

export function parseHookPayloadText(text: string): HookPayloadParseResult {
  const trimmed = stripUtf8BomString(text).trim();
  if (!trimmed) {
    return { ok: false, reason: "PR Genie gate received no input" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "PR Genie gate received unparseable hook input" };
    }
    return { ok: true, input: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "PR Genie gate received unparseable hook input" };
  }
}

/**
 * Read all bytes from hook stdin (async `process.stdin`, same pattern as MCP stdio).
 */
export function readHookStdin(): Promise<HookStdinReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let readError: string | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({ raw: Buffer.concat(chunks), readError });
    };

    process.stdin.on("error", (err) => {
      readError = err instanceof Error ? err.message : String(err);
      finish();
    });
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.resume();
  });
}

/** Normalize Cursor `/c:/Users/...` workspace roots on Windows. */
export function normalizeHookWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  const posixDrive = trimmed.match(/^\/([a-zA-Z]):\/?(.*)$/);
  if (posixDrive) {
    const rest = posixDrive[2].replace(/\//g, path.sep);
    return path.normalize(`${posixDrive[1].toUpperCase()}:${path.sep}${rest}`);
  }
  return path.normalize(trimmed);
}

/** When set by a human in the environment, restore RAD-185 `ask` for hosts that honor it (RAD-188 R5). */
export function hookPrefersAskOverDeny(): boolean {
  const v = process.env.PRGENIE_GITHUB_GATE_ASK?.trim();
  if (!v) return false;
  return v === "1" || /^true$/i.test(v) || /^yes$/i.test(v);
}

export function gateNoInputPayload(reason: string): {
  permission: "ask" | "deny";
  user_message: string;
  agent_message: string;
} {
  if (hookPrefersAskOverDeny()) {
    return {
      permission: "ask",
      user_message: `${reason}. Confirm only if you trust this action.`,
      agent_message: `${reason}. Do not git push, gh pr create/merge, or export unless the user explicitly approved.`,
    };
  }
  return {
    permission: "deny",
    user_message: `${reason}. Use **Open on GitHub** in the Local PRs panel or \`prgenie export <id>\` yourself.`,
    agent_message: `${reason}. Do not retry or work around this block. Stop and tell the user to export from the panel or CLI if they need to publish.`,
  };
}
