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

export const PRGENIE_GITHUB_GATE_ASK_ENV = "PRGENIE_GITHUB_GATE_ASK";
const GATE_ASK_NAME = PRGENIE_GITHUB_GATE_ASK_ENV;

/** Persistent or process environment writers, matched only when the command also names the flag. */
const GATE_ASK_ENV_WRITERS: readonly RegExp[] = [
  /\bsetx(\.exe)?\b/i,
  /\breg(\.exe)?\s+(add|import|copy|restore|load)\b/i,
  /\b(New|Set|Copy|Move|Rename)-ItemProperty\b/i,
  /\b(New|Set|Copy|Move|Rename)-Item\b/i,
  /\b(Set|Add)-Content\b/i,
  /\b(New|Set)-(CimInstance|WmiInstance)\b/i,
  /\bwmic\b[^\n]*\benvironment\b/i,
  /\bSetEnvironmentVariable\b/i,
  /\bSetValue(Ex)?\b/i,
  /\blaunchctl\s+setenv\b/i,
  /\bputenv\b/i,
  // PowerShell aliases for the item / item-property writers above.
  /(^|[\s;&|(])(sp|si|ni|cpp|mp|rnp|sc|ac)\s/i,
  new RegExp(String.raw`\bexport\s+(-\w+\s+)*${GATE_ASK_NAME}\b`, "i"),
  new RegExp(String.raw`\b(declare|typeset|readonly|local)\s+(-\w+\s+)*${GATE_ASK_NAME}=`, "i"),
  new RegExp(String.raw`\$\{?env:${GATE_ASK_NAME}\}?\s*[+]?=(?!=)`, "i"),
  new RegExp(String.raw`\bset\s+(\/[ap]\s+)?"?${GATE_ASK_NAME}\s*=`, "i"),
  new RegExp(String.raw`\bset\s+-[a-zA-Z]*x[a-zA-Z]*\s+${GATE_ASK_NAME}\b`, "i"),
  new RegExp(String.raw`(^\s*|[;&|(\n]\s*|\benv\s+(-\w+\s+)*)${GATE_ASK_NAME}=`, "i"),
  new RegExp(
    String.raw`(process\.env\.|process\.env\[['"]|os\.environ\[['"])${GATE_ASK_NAME}['"]?\]?\s*=(?!=)`,
    "i",
  ),
];

/** Any registry path: a write here without a read-only verb is treated as a writer. */
const REGISTRY_PATH = /\b(HKCU|HKLM|HKEY_[A-Z_]+|Registry::)|\\Environment\b/i;
const REGISTRY_READ_ONLY =
  /\b(reg(\.exe)?\s+query|Get-ItemProperty(Value)?|Get-Item|Get-ChildItem|gp|gpv|gi|gci)\b/i;

/** Strip cmd `^` / PowerShell backtick escapes and empty quote pairs that split the name in source text. */
function normalizeForGateAskScan(command: string): string {
  return command.replace(/[\^`]/g, "").replace(/""|''/g, "");
}

/**
 * Agents must not set the R5 escape hatch (RAD-188 R5): deny any command that names the flag
 * (case-insensitive — Windows env names are) and writes environment or registry state. Pure reads
 * (`rg`, `echo $env:...`, `reg query`, `Get-ItemProperty`) stay allowed.
 */
export function shellCommandSetsGithubGateAskFlag(command: string): boolean {
  const text = normalizeForGateAskScan(command);
  if (!text.toUpperCase().includes(GATE_ASK_NAME)) return false;
  if (GATE_ASK_ENV_WRITERS.some((re) => re.test(text))) return true;
  return REGISTRY_PATH.test(text) && !REGISTRY_READ_ONLY.test(text);
}

export function gateEscapeHatchSetDenyPayload(): {
  permission: "deny";
  user_message: string;
  agent_message: string;
} {
  return {
    permission: "deny",
    user_message:
      "PR Genie: agents cannot change the github gate escape hatch (`PRGENIE_GITHUB_GATE_ASK`). Set it yourself outside Cursor if needed.",
    agent_message:
      "Do not set PRGENIE_GITHUB_GATE_ASK via shell or work around gate denies. Stop and tell the user to configure the variable themselves if they want ask mode.",
  };
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
