import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";

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

const raw = readFileSync(0, "utf8");
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

const cwd = input.cwd || input.workspace_roots?.[0] || process.cwd();
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
