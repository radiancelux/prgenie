import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitCommonDir } from "./git.js";

/** Last N lines shown in toast / CLI when no first-failing-test parse. */
export const CI_EXCERPT_LINES = 8;
/** Hard cap so toasts never ingest megabytes. */
export const CI_EXCERPT_MAX_CHARS = 480;
/** Persist enough for `shepherd --verbose` / doctor without huge files. */
export const CI_LOG_MAX_BYTES = 64 * 1024;

export interface ExecFailureOutput {
  firstLine: string;
  stdout: string;
  stderr: string;
  combined: string;
}

export interface CiFailureLogMeta {
  check: string;
  command: string;
  excerpt: string;
  logPath: string;
  writtenAt: string;
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

const NOISE_LINE =
  /^(?:npm ERR!|pnpm ERR!|ELIFECYCLE|Command failed:|ERROR: command failed|error Command failed)/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function collectExecOutput(err: unknown): ExecFailureOutput {
  const e = err as { message?: string; stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = (message.split("\n")[0] || message).trim() || "Command failed";
  let combined = [stderr, stdout].filter((s) => s.trim()).join("\n");
  if (!combined.trim()) {
    const rest = message.split("\n").slice(1).join("\n").trim();
    combined = rest;
  }
  return { firstLine, stdout, stderr, combined };
}

export function lastNonEmptyLines(text: string, n: number): string {
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !NOISE_LINE.test(line.trim()));
  return lines.slice(-n).join("\n");
}

export function truncateChars(text: string, max = CI_EXCERPT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+\n/g, "\n").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function flattenExcerpt(text: string): string {
  return truncateChars(text.replace(/\n+/g, " · "));
}

/** First failing test name from node:test / TAP / Jest / Vitest / Mocha, when parseable. */
export function parseFirstFailingTest(text: string): string | null {
  const clean = stripAnsi(text);
  const tap = clean.match(/^not ok\s+\d+\s+-\s+(.+)$/m);
  if (tap?.[1]) return tap[0].trim();
  const spec = clean.match(/^[✖×]\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/m);
  if (spec?.[1]) return spec[0].trim();
  const jest = clean.match(/^●\s+(.+)$/m);
  if (jest?.[1]) return `● ${jest[1].trim()}`;
  const mocha = clean.match(/^\s*(\d+)\)\s+(.+)$/m);
  if (mocha?.[2]) return `${mocha[1]}) ${mocha[2].trim()}`;
  const failFile = clean.match(/^FAIL\s+(\S+)/m);
  if (failFile?.[1]) return `FAIL ${failFile[1]}`;
  return null;
}

function parseLintExcerpt(text: string): string | null {
  const clean = stripAnsi(text);
  const file = clean.match(/^(?:[\w./\\-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json))\b.*$/m);
  const err = clean.match(/^\s+\d+:\d+\s+error\s+.+$/m);
  if (file && err) {
    const base = path.basename(file[0].trim().split(/\s+/)[0] ?? file[0]);
    return `${base} ${err[0].trim()}`;
  }
  if (err) return err[0].trim();
  const summary = clean.match(/^✖\s+.+$/m);
  return summary?.[0]?.trim() ?? null;
}

function parseTypecheckExcerpt(text: string): string | null {
  const clean = stripAnsi(text);
  const ts = clean.match(/^[^\n]*error TS\d+:[^\n]+$/m);
  if (ts) return ts[0].trim();
  const generic = clean.match(/^[^\n]*error TS[^\n]+$/m);
  return generic?.[0]?.trim() ?? null;
}

function parseFormatExcerpt(text: string): string | null {
  const clean = stripAnsi(text);
  if (/Prettier format check failed/i.test(clean)) {
    const line = clean.split("\n").find((l) => /Prettier format check failed/i.test(l));
    return line?.trim() ?? null;
  }
  const warn = clean.match(/^\[warn\]\s+.+$/m);
  return warn?.[0]?.trim() ?? null;
}

function parseBuildExcerpt(text: string): string | null {
  const clean = stripAnsi(text);
  const err = clean.match(/^[^\n]*(?:error|Error|ERROR)[^\n]*$/m);
  return err?.[0]?.trim() ?? null;
}

/** Best-effort one-line excerpt per gate. Test prefers the first failing test name. */
export function parseGateExcerpt(check: string, text: string): string | null {
  const name = check === "format:check" || check === "format" ? "format" : check;
  if (name === "test") return parseFirstFailingTest(text);
  if (name === "lint") return parseLintExcerpt(text);
  if (name === "typecheck") return parseTypecheckExcerpt(text);
  if (name === "format") return parseFormatExcerpt(text);
  if (name === "build") return parseBuildExcerpt(text);
  return parseFirstFailingTest(text);
}

export function formatFailureExcerpt(check: string, output: ExecFailureOutput): string {
  const source = output.combined.trim() ? output.combined : output.firstLine;
  const parsed = parseGateExcerpt(check, source);
  if (parsed) return flattenExcerpt(parsed);
  const tail = lastNonEmptyLines(source, CI_EXCERPT_LINES);
  if (tail) return flattenExcerpt(tail);
  return flattenExcerpt(output.firstLine);
}

export function formatCiCheckError(input: {
  command: string;
  excerpt: string;
  logPath?: string | null;
}): string {
  const parts = [input.command];
  if (input.excerpt && input.excerpt !== input.command) parts.push(input.excerpt);
  if (input.logPath) parts.push(`full log: ${input.logPath}`);
  return parts.join(" — ");
}

export function displayLogPath(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  return rel && !rel.startsWith("..") ? rel : absPath;
}

export async function ciLogsDir(cwd: string, create = true): Promise<string> {
  const common = await gitCommonDir(cwd);
  const dir = path.join(common, "agent-console", "ci-logs");
  if (create) await mkdir(dir, { recursive: true });
  return dir;
}

function safeCheckFile(check: string): string {
  return check.replace(/[^a-zA-Z0-9._-]+/g, "_") || "check";
}

function truncateBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  const slice = buf.subarray(buf.length - max);
  return `…(truncated to last ${max} bytes)\n${slice.toString("utf8")}`;
}

/** Persist full (capped) stdout/stderr. Fail-soft — excerpt still surfaces without a path. */
export async function writeCiFailureLog(
  cwd: string,
  check: string,
  command: string,
  output: ExecFailureOutput,
  excerpt: string,
): Promise<string | null> {
  try {
    const dir = await ciLogsDir(cwd);
    const logPath = path.join(dir, `${safeCheckFile(check)}.log`);
    const header = `# ${check} (${command}) failed ${new Date().toISOString()}\n\n`;
    const body = truncateBytes(
      `${header}${output.combined.trim() || output.firstLine}\n`,
      CI_LOG_MAX_BYTES,
    );
    await writeFile(logPath, body, "utf8");
    const meta: CiFailureLogMeta = {
      check,
      command,
      excerpt,
      logPath,
      writtenAt: new Date().toISOString(),
    };
    await writeFile(path.join(dir, "latest.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return displayLogPath(cwd, logPath);
  } catch {
    return null;
  }
}

export async function listCiFailureLogs(cwd: string): Promise<CiFailureLogMeta[]> {
  try {
    const dir = await ciLogsDir(cwd, false);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".log"));
    const latestRaw = await readFile(path.join(dir, "latest.json"), "utf8").catch(() => null);
    let latest: CiFailureLogMeta | null = null;
    if (latestRaw) {
      try {
        latest = JSON.parse(latestRaw) as CiFailureLogMeta;
      } catch {
        latest = null;
      }
    }
    const out: CiFailureLogMeta[] = [];
    for (const name of names.sort()) {
      const logPath = path.join(dir, name);
      const check = name.replace(/\.log$/, "").replace(/_/g, ":");
      if (latest && path.resolve(latest.logPath) === path.resolve(logPath)) {
        out.push({ ...latest, logPath: displayLogPath(cwd, logPath) });
        continue;
      }
      out.push({
        check,
        command: `pnpm ${check}`,
        excerpt: "",
        logPath: displayLogPath(cwd, logPath),
        writtenAt: "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function readCiFailureLog(cwd: string, logPath: string): Promise<string | null> {
  try {
    const abs = path.isAbsolute(logPath) ? logPath : path.resolve(cwd, logPath);
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

export async function latestCiFailure(cwd: string): Promise<CiFailureLogMeta | null> {
  try {
    const dir = await ciLogsDir(cwd, false);
    const raw = await readFile(path.join(dir, "latest.json"), "utf8");
    const meta = JSON.parse(raw) as CiFailureLogMeta;
    if (!meta || typeof meta.check !== "string" || typeof meta.logPath !== "string") return null;
    return { ...meta, logPath: displayLogPath(cwd, meta.logPath) };
  } catch {
    return null;
  }
}
