import { writeSync } from "node:fs";
import { loadConfig, runnerTokenFile } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { runnerListenUrls } from "./listen-urls.js";
import { bindRunnerHttpServer } from "./http-bind.js";
import { startHttpServer } from "./server.js";
import { listJobs } from "./store.js";
import { removeWorktree } from "./worktree.js";
import { MCP_STDIO_READY, serveMcpStdio } from "./mcp-stdio.js";
import {
  CONFIG_CLIENT_IDS,
  claudeCodeMcpAddCommand,
  claudeDesktopMcpJsonSnippet,
  cursorMcpJsonSnippet,
  formatInitReport,
  runInit,
  vscodeMcpJsonSnippet,
} from "./init.js";
import { unknownRunnerCommandMessage } from "./runner-cli-hints.js";
import { runningViaNpx } from "./cli-invocation.js";
import { formatRunnerDoctorReport, runRunnerDoctor } from "./runner-doctor.js";
import { runJobWorker } from "./job-worker.js";
import { runRunnerRestartCli } from "./runner-restart.js";
import { spawn } from "node:child_process";
import { runCli } from "./cli-errors.js";
import { runnerCliVersion } from "./version.js";

async function cmdServe(): Promise<void> {
  process.env.PRGENIE_RUNNER_ROLE = "serve";
  const config = await loadConfig(process.env, { command: "serve" });
  const engine = new RunnerEngine(config);
  await engine.init();
  const server = startHttpServer(config, engine);
  await bindRunnerHttpServer(server, config.host, config.port);
  const urls = runnerListenUrls(config.host, config.port);
  const tokenPath = runnerTokenFile(config.dataDir);
  // eslint-disable-next-line no-console
  console.log(
    [
      `PR Genie runner listening on ${config.host}:${config.port} — UI ${urls.join(", ")} (MCP POST /mcp)`,
      `Bearer token file: ${tokenPath} (paste in dashboard; never log the token itself).`,
    ].join("\n"),
  );
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      engine.ciWatcher.stop();
      void server.shutdown().then(resolve);
    });
  });
  // Supervisor polls would otherwise keep the loop alive; detached workers carry on regardless.
  process.exit(0);
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
  process.stdout.write(formatInitReport(result, process.env));
}

async function cmdDoctor(): Promise<void> {
  const report = await runRunnerDoctor(process.env);
  process.stdout.write(formatRunnerDoctorReport(report, process.env));
  if (!report.ok) process.exit(1);
}

function configUseGlobal(): boolean {
  if (process.argv.includes("--global")) return true;
  if (process.argv.includes("--npx")) return false;
  return !runningViaNpx(process.env);
}

function cmdConfig(): void {
  const clientIdx = process.argv.indexOf("--client");
  const client = clientIdx >= 0 ? process.argv[clientIdx + 1] : null;
  if (client && !CONFIG_CLIENT_IDS.includes(client as (typeof CONFIG_CLIENT_IDS)[number])) {
    throw new Error(`unknown --client ${client} (expected: ${CONFIG_CLIENT_IDS.join("|")})`);
  }
  const useGlobal = configUseGlobal();
  if (client === "cursor") {
    process.stdout.write(cursorMcpJsonSnippet(useGlobal));
    return;
  }
  if (client === "vscode") {
    process.stdout.write(vscodeMcpJsonSnippet(useGlobal));
    return;
  }
  if (client === "claude-code") {
    process.stdout.write(claudeCodeMcpAddCommand(useGlobal));
    return;
  }
  if (client === "claude-desktop") {
    process.stdout.write(claudeDesktopMcpJsonSnippet(useGlobal));
    return;
  }
  process.stdout.write(
    [
      `Usage: prgenie config --client ${CONFIG_CLIENT_IDS.join("|")} [--global|--npx]`,
      "",
      useGlobal
        ? "Using global/prgenie on PATH (--global default when not launched via npx)."
        : "Using npx (--npx default when launched via npx).",
      "",
      "Generic stdio (portable .mcp.json):",
      cursorMcpJsonSnippet(useGlobal),
    ].join("\n"),
  );
}

async function cmdJobWorker(): Promise<void> {
  const jobId = process.argv[3]?.trim();
  if (!jobId) {
    throw new Error("Usage: prgenie job-worker <job-id>");
  }
  const code = await runJobWorker(jobId);
  process.exitCode = code;
}

function resolveRunnerEntryForRestart(): string {
  const override = process.env.PRGENIE_RUNNER_BINARY?.trim();
  if (override) return override;
  const bundled = process.argv[1];
  if (bundled) return bundled;
  throw new Error(
    "cannot resolve runner entry for restart (set PRGENIE_RUNNER_BINARY or use runner.cjs)",
  );
}

async function cmdRunnerRestart(): Promise<void> {
  const config = await loadConfig(process.env, { command: "restart" });
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const entry = resolveRunnerEntryForRestart();
  const launcher = process.env.PRGENIE_RUNNER_RESTART_LAUNCHER?.trim() || process.execPath;
  process.exitCode = await runRunnerRestartCli(
    {
      build: process.argv.includes("--build"),
      entry,
      host,
      port: config.port,
      token: config.token,
    },
    {
      launch: () =>
        spawn(launcher, [entry, "serve"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            PRGENIE_RUNNER_ROLE: "serve",
            PRGENIE_RUNNER_HOST: config.host,
            PRGENIE_RUNNER_PORT: String(config.port),
            PRGENIE_RUNNER_DATA_DIR: config.dataDir,
            PRGENIE_RUNNER_TOKEN: config.token,
          },
        }).unref(),
    },
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

const KNOWN_COMMANDS = new Set([
  "serve",
  "mcp",
  "init",
  "doctor",
  "config",
  "prune-worktrees",
  "job-worker",
  "restart",
]);

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`prgenie — local runner (install via npm: npx -y prgenie)

Usage:
  prgenie init [--data-dir PATH] [--force-token]
  prgenie doctor
  prgenie mcp              MCP over stdio (no bearer token)
  prgenie serve            HTTP dashboard + bearer MCP
  prgenie restart [--build]  Graceful HTTP restart (detached workers keep running)
  prgenie job-worker <id>    Internal: detached job loop (do not call by hand)
  prgenie config --client cursor|vscode|claude-code|claude-desktop [--global|--npx]
  prgenie prune-worktrees

Options:
  --version, -v            Print version and exit
  --help, -h, help         Print this help and exit

Env: PRGENIE_RUNNER_DATA_DIR, PRGENIE_RUNNER_TOKEN (serve override; serve also reads runner.token),
     PRGENIE_RUNNER_HOST, PRGENIE_RUNNER_PORT, PRGENIE_RUNNER_DRY_RUN=1`);
}

async function main(): Promise<void> {
  const argv = process.argv;
  const cmd = argv[2];

  if (cmd === "--version" || cmd === "-v") {
    // eslint-disable-next-line no-console
    console.log(runnerCliVersion());
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === undefined) {
    printUsage();
    return;
  }

  if (!KNOWN_COMMANDS.has(cmd)) {
    throw new Error(unknownRunnerCommandMessage(cmd));
  }

  if (cmd === "serve") await cmdServe();
  else if (cmd === "mcp") await cmdMcpStdio();
  else if (cmd === "init") await cmdInit();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "config") cmdConfig();
  else if (cmd === "prune-worktrees") await cmdPrune();
  else if (cmd === "job-worker") await cmdJobWorker();
  else if (cmd === "restart") await cmdRunnerRestart();
}

runCli(main);
