import { writeSync } from "node:fs";
import { loadConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { runnerListenUrls } from "./listen-urls.js";
import { startHttpServer } from "./server.js";
import { listJobs } from "./store.js";
import { removeWorktree } from "./worktree.js";
import { MCP_STDIO_READY, serveMcpStdio } from "./mcp-stdio.js";
import {
  claudeCodeMcpAddCommand,
  cursorMcpJsonSnippet,
  formatInitReport,
  runInit,
  vscodeMcpJsonSnippet,
} from "./init.js";
import { formatRunnerDoctorReport, runRunnerDoctor } from "./runner-doctor.js";
import { runJobWorker } from "./job-worker.js";
import {
  httpCallRunnerRestart,
  waitForHttpRunner,
} from "./runner-restart.js";
import { spawn } from "node:child_process";
import path from "node:path";

async function cmdServe(): Promise<void> {
  process.env.PRGENIE_RUNNER_ROLE = "serve";
  const config = await loadConfig(process.env, { command: "serve" });
  const engine = new RunnerEngine(config);
  await engine.init();
  const server = startHttpServer(config, engine, {
    onGracefulShutdown: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
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
  await serveMcpStdio(
    process.stdin,
    (frame) => writeSync(1, frame),
    (msg) => handleMcpJsonRpc(engine, msg),
  );
  // Client hung up: drop the CI poll interval so the process exits once in-flight jobs settle
  // instead of lingering as an orphan under npx.
  engine.ciWatcher.stop();
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
  if (client === "claude-code") {
    process.stdout.write(claudeCodeMcpAddCommand());
    return;
  }
  process.stdout.write(
    [
      "Usage: prgenie config --client cursor|vscode|claude-code",
      "",
      "Generic stdio (Claude Desktop, portable .mcp.json):",
      cursorMcpJsonSnippet(),
    ].join("\n"),
  );
}

async function cmdJobWorker(): Promise<void> {
  const jobId = process.argv[3]?.trim();
  if (!jobId) {
    console.error("Usage: prgenie job-worker <job-id>");
    process.exit(1);
  }
  const code = await runJobWorker(jobId);
  process.exitCode = code;
}

function resolveRunnerEntryForRestart(): string {
  const override = process.env.PRGENIE_RUNNER_BINARY?.trim();
  if (override) return override;
  const bundled = process.argv[1];
  if (bundled) return bundled;
  throw new Error("cannot resolve runner entry for restart (set PRGENIE_RUNNER_BINARY or use runner.cjs)");
}

async function cmdRunnerRestart(): Promise<void> {
  const build = process.argv.includes("--build");
  const config = await loadConfig(process.env, { command: "restart" });
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const token = config.token;
  try {
    await httpCallRunnerRestart(host, config.port, token);
  } catch {
    // old server may already be down
  }
  if (build) {
    const root = path.resolve(path.dirname(resolveRunnerEntryForRestart()), "../..");
    await new Promise<void>((resolve, reject) => {
      const p = spawn("pnpm", ["build"], { cwd: root, stdio: "inherit", env: process.env });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pnpm build: ${code}`))));
    });
  }
  const entry = resolveRunnerEntryForRestart();
  const launcher = process.env.PRGENIE_RUNNER_RESTART_LAUNCHER?.trim() || process.execPath;
  const args =
    launcher === "tsx" || launcher.endsWith("/tsx")
      ? [entry, "serve"]
      : launcher === process.execPath
        ? [entry, "serve"]
        : [entry, "serve"];
  spawn(launcher, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PRGENIE_RUNNER_ROLE: "serve",
      PRGENIE_RUNNER_HOST: config.host,
      PRGENIE_RUNNER_PORT: String(config.port),
      PRGENIE_RUNNER_DATA_DIR: config.dataDir,
      PRGENIE_RUNNER_TOKEN: token,
    },
  }).unref();
  const ok = await waitForHttpRunner(host, config.port, token);
  if (!ok) {
    console.error("Runner did not come back up after restart.");
    process.exitCode = 1;
    return;
  }
  console.log(`Runner restarted on ${host}:${config.port}`);
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
  prgenie restart [--build]  Graceful HTTP restart (detached workers keep running)
  prgenie job-worker <id>    Internal: detached job loop (do not call by hand)
  prgenie config --client cursor|vscode|claude-code
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
else if (cmd === "job-worker") void cmdJobWorker();
else if (cmd === "restart") void cmdRunnerRestart();
else usage();
