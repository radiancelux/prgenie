import { writeSync } from "node:fs";
import { loadConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { startHttpServer } from "./server.js";
import { listJobs } from "./store.js";
import { removeWorktree } from "./worktree.js";
import { encodeMcpFrame, takeMcpMessages } from "./mcp-stdio.js";

async function cmdServe(): Promise<void> {
  const config = await loadConfig();
  const engine = new RunnerEngine(config);
  await engine.init();
  const server = startHttpServer(config, engine);
  // eslint-disable-next-line no-console
  console.log(`PR Genie local runner on http://127.0.0.1:${config.port} (MCP POST /mcp, UI /)`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close(() => resolve());
    });
  });
}

async function cmdMcpStdio(): Promise<void> {
  const config = await loadConfig();
  const engine = new RunnerEngine(config);
  await engine.init();
  writeSync(2, "[prgenie-local-runner] mcp stdio ready\n");
  let buffer: Buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]) as Buffer;
    const { messages, rest } = takeMcpMessages(buffer);
    buffer = rest;
    for (const raw of messages) {
      void (async () => {
        const msg = raw as { id?: unknown; method?: string; params?: Record<string, unknown> };
        const reply = await handleMcpJsonRpc(engine, msg);
        if (reply) writeSync(1, encodeMcpFrame(reply));
      })();
    }
  });
}

async function cmdPrune(): Promise<void> {
  const config = await loadConfig();
  const jobs = await listJobs(config.dataDir);
  let n = 0;
  for (const job of jobs) {
    if (!job.worktreePath) continue;
    if (!["failed", "stuck", "changes_remaining"].includes(job.stage)) continue;
    if (job.input.repoPath) {
      await removeWorktree(job.input.repoPath, job.worktreePath);
    }
    n++;
  }
  // eslint-disable-next-line no-console
  console.log(`Pruned ${n} failed/stuck worktrees (kept job JSON on disk).`);
}

function usage(): never {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  prgenie-local-runner serve       HTTP UI + MCP (localhost)
  prgenie-local-runner mcp         MCP over stdio (Cursor)
  prgenie-local-runner prune-worktrees
Env: PRGENIE_RUNNER_TOKEN (required), PRGENIE_RUNNER_PORT, PRGENIE_RUNNER_DATA_DIR,
     PRGENIE_RUNNER_NOTIFY_EMAIL, RESEND_API_KEY, PRGENIE_RUNNER_DRY_RUN=1`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "serve") void cmdServe();
else if (cmd === "mcp") void cmdMcpStdio();
else if (cmd === "prune-worktrees") void cmdPrune();
else usage();
