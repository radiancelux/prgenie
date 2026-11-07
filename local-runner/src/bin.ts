import { writeSync } from "node:fs";
import { loadConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { runnerListenUrls } from "./listen-urls.js";
import { startHttpServer } from "./server.js";
import { listJobs } from "./store.js";
import { removeWorktree } from "./worktree.js";
import { encodeMcpFrame, MCP_STDIO_READY, takeMcpMessages } from "./mcp-stdio.js";
import { formatInitReport, runInit, cursorMcpJsonSnippet, vscodeMcpJsonSnippet } from "./init.js";
import { formatRunnerDoctorReport, runRunnerDoctor } from "./runner-doctor.js";

async function cmdServe(): Promise<void> {
  const config = await loadConfig(process.env, { command: "serve" });
  const engine = new RunnerEngine(config);
  await engine.init();
  const server = startHttpServer(config, engine);
  const urls = runnerListenUrls(config.host, config.port);
  // eslint-disable-next-line no-console
  console.log(
    `PR Genie runner listening on ${config.host}:${config.port} — UI ${urls.join(", ")} (MCP POST /mcp)`,
  );
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close(() => resolve());
    });
  });
}

async function cmdMcpStdio(): Promise<void> {
  const config = await loadConfig(process.env, { command: "mcp" });
  const engine = new RunnerEngine(config);
  await engine.init();
  writeSync(2, `${MCP_STDIO_READY}\n`);
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

async function cmdInit(): Promise<void> {
  const force = process.argv.includes("--force-token");
  const dataDirFlag = process.argv.findIndex((a) => a === "--data-dir");
  const dataDir =
    dataDirFlag >= 0 && process.argv[dataDirFlag + 1] ? process.argv[dataDirFlag + 1] : undefined;
  const result = await runInit({ dataDir, forceToken: force });
  process.stdout.write(formatInitReport(result));
}

async function cmdDoctor(): Promise<void> {
  const report = await runRunnerDoctor(process.env);
  process.stdout.write(formatRunnerDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

function cmdConfig(): void {
  const clientIdx = process.argv.indexOf("--client");
  const client = clientIdx >= 0 ? process.argv[clientIdx + 1] : null;
  if (client === "cursor") {
    process.stdout.write(cursorMcpJsonSnippet());
    return;
  }
  if (client === "vscode") {
    process.stdout.write(vscodeMcpJsonSnippet());
    return;
  }
  process.stdout.write(
    [
      "Usage: prgenie config --client cursor|vscode",
      "",
      "Generic stdio (Claude Desktop, portable .mcp.json):",
      cursorMcpJsonSnippet(),
    ].join("\n"),
  );
}

async function cmdPrune(): Promise<void> {
  const config = await loadConfig(process.env, { command: "mcp" });
  const jobs = await listJobs(config.dataDir, { includeArchived: true });
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
  console.log(`prgenie — local runner (install via npm: npx -y prgenie)

Usage:
  prgenie init [--data-dir PATH] [--force-token]
  prgenie doctor
  prgenie mcp              MCP over stdio (no bearer token)
  prgenie serve            HTTP dashboard + bearer MCP
  prgenie config --client cursor|vscode
  prgenie prune-worktrees

Env: PRGENIE_RUNNER_DATA_DIR, PRGENIE_RUNNER_TOKEN (serve only),
     PRGENIE_RUNNER_HOST, PRGENIE_RUNNER_PORT, PRGENIE_RUNNER_DRY_RUN=1`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "serve") void cmdServe();
else if (cmd === "mcp") void cmdMcpStdio();
else if (cmd === "init") void cmdInit();
else if (cmd === "doctor") void cmdDoctor();
else if (cmd === "config") cmdConfig();
else if (cmd === "prune-worktrees") void cmdPrune();
else usage();
