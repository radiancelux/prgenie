import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function gitText(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : ""));
  });
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readHookStdinBuffer() {
  return new Promise((resolve) => {
    const chunks = [];
    let readError = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ raw: Buffer.concat(chunks), readError });
    };
    process.stdin.on("error", (err) => {
      readError = err instanceof Error ? err.message : String(err);
      finish();
    });
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.resume();
  });
}

function parseHookPayload(raw) {
  if (raw.length === 0) return {};
  let body = raw;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    body = raw.subarray(3);
  }
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(stripUtf8Bom(body.toString("utf8")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeHookWorkspacePath(raw) {
  const trimmed = String(raw).trim();
  const m = trimmed.match(/^\/([a-zA-Z]):\/?(.*)$/);
  if (m) {
    const rest = m[2].replace(/\//g, path.sep);
    return path.normalize(`${m[1].toUpperCase()}:${path.sep}${rest}`);
  }
  return path.normalize(trimmed);
}

const { raw } = await readHookStdinBuffer();
const input = parseHookPayload(raw);

const cwdRaw = input.cwd || input.workspace_roots?.[0] || process.cwd();
const cwd = typeof cwdRaw === "string" ? normalizeHookWorkspacePath(cwdRaw) : process.cwd();
const toplevel = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
if (!toplevel) {
  process.stdout.write("{}\n");
  process.exit(0);
}
const common = await gitText(toplevel, ["rev-parse", "--git-common-dir"]);
const commonDir = path.isAbsolute(common) ? common : path.resolve(toplevel, common);
const dir = path.join(commonDir, "agent-console");
await mkdir(dir, { recursive: true });
const line = JSON.stringify({
  hook: input.hook_event_name || input.event || "session",
  conversation_id: input.conversation_id ?? input.parent_conversation_id ?? null,
  subagent_id: input.subagent_id ?? null,
  subagent_type: input.subagent_type ?? null,
  task: input.task ?? input.description ?? null,
  status: input.status ?? null,
  cwd,
  gitRoot: toplevel,
  at: new Date().toISOString(),
});
await appendFile(path.join(dir, "sessions.jsonl"), `${line}\n`, "utf8");
process.stdout.write("{}\n");
