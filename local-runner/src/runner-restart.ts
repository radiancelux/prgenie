import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { liveWorkerLock, readWorkerLock } from "./job-worker-lock.js";
import { listJobs } from "./store.js";
import type { JobRecord } from "./types.js";

export type RestartPrepareResult = {
  ok: true;
  adoptedJobIds: string[];
  interruptedJobIds: string[];
  idle: boolean;
};

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

/** Active jobs whose worker survives a restart (`adopted`) or is confirmed gone (`lost`). */
export function adoptableJobs(
  dataDir: string,
  jobs: JobRecord[],
): { adopted: string[]; lost: string[] } {
  const adopted: string[] = [];
  const lost: string[] = [];
  for (const job of jobs) {
    if (!ACTIVE_STAGES.has(job.stage) || job.queueState?.queued) continue;
    if (liveWorkerLock(dataDir, job.id)) {
      adopted.push(job.id);
    } else if (job.worker || readWorkerLock(dataDir, job.id)) {
      lost.push(job.id);
    }
  }
  return { adopted, lost };
}

export async function inspectRestartState(config: RunnerConfig): Promise<RestartPrepareResult> {
  const jobs = await listJobs(config.dataDir);
  const { adopted, lost } = adoptableJobs(config.dataDir, jobs);
  const active = jobs.filter(
    (j) => ACTIVE_STAGES.has(j.stage) && !j.queueState?.queued && !j.stopRequested,
  );
  return {
    ok: true,
    adoptedJobIds: adopted,
    interruptedJobIds: lost,
    idle: active.length === 0,
  };
}

export async function httpCallRunnerRestart(
  host: string,
  port: number,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: "/api/runner/restart",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body: unknown = Buffer.concat(chunks).toString("utf8");
          try {
            body = JSON.parse(String(body));
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function waitForHttpRunner(
  host: string,
  port: number,
  token: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise<boolean>((resolve, reject) => {
        const req = http.request(
          {
            hostname: host,
            port,
            path: "/api/jobs/meta",
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on("error", reject);
        req.end();
      });
      if (ok) return true;
    } catch {
      // not up
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** True once nothing accepts TCP connections on `host:port` (the old server has exited). */
export async function waitForPortFree(
  host: string,
  port: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (!listening) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Repo root for `restart --build`: the nearest ancestor of `entry` holding the pnpm workspace. */
export function findBuildRoot(entry: string): string | null {
  let dir = path.dirname(path.resolve(entry));
  for (;;) {
    if (
      existsSync(path.join(dir, "pnpm-workspace.yaml")) &&
      existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function runPnpmBuild(root: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("pnpm", ["build"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`pnpm build exited ${code}`)),
    );
  });
}

export type RestartCliDeps = {
  build?: (root: string) => Promise<void>;
  callRestart?: typeof httpCallRunnerRestart;
  waitForPortFree?: (host: string, port: number) => Promise<boolean>;
  launch: () => void;
  waitForUp?: (host: string, port: number, token: string) => Promise<boolean>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type RestartCliOptions = {
  build: boolean;
  /** Runner entry (`runner.cjs` / `bin.ts`); locates the repo for `--build`. */
  entry: string;
  host: string;
  port: number;
  token: string;
};

function bodyError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) return String(body.error);
  return typeof body === "string" ? body.slice(0, 200) : "";
}

/**
 * `prgenie restart [--build]`. Builds first so a broken build leaves the old server running,
 * then asks the old server to exit, waits for its port to free, launches the new one, and
 * waits for it to answer. Returns the process exit code.
 */
export async function runRunnerRestartCli(
  opts: RestartCliOptions,
  deps: RestartCliDeps,
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));
  const { host, port, token } = opts;

  if (opts.build) {
    const root = findBuildRoot(opts.entry);
    if (!root) {
      error(`--build needs a source checkout: no pnpm-workspace.yaml above ${opts.entry}`);
      return 1;
    }
    log(`Building in ${root} …`);
    try {
      await (deps.build ?? runPnpmBuild)(root);
    } catch (err) {
      error(`Build failed; runner left running: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  let oldServerUp = true;
  try {
    const res = await (deps.callRestart ?? httpCallRunnerRestart)(host, port, token);
    if (res.status !== 200) {
      const detail = bodyError(res.body);
      error(`Runner refused restart: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
      return 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
      error(`Restart request failed: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
    oldServerUp = false;
    log(`No runner on ${host}:${port}; starting one.`);
  }

  if (oldServerUp && !(await (deps.waitForPortFree ?? waitForPortFree)(host, port))) {
    error(`Old runner still holds ${host}:${port}; not launching a second one.`);
    return 1;
  }

  deps.launch();
  if (!(await (deps.waitForUp ?? waitForHttpRunner)(host, port, token))) {
    error("Runner did not come back up after restart.");
    return 1;
  }
  log(`Runner restarted on ${host}:${port}`);
  return 0;
}
