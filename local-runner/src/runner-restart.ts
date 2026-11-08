import http from "node:http";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { workerLooksAlive } from "./job-worker-monitor.js";
import { listJobs } from "./store.js";
import type { JobRecord } from "./types.js";

export type RestartPrepareResult = {
  ok: true;
  adoptedJobIds: string[];
  interruptedJobIds: string[];
  idle: boolean;
};

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export function adoptableJobs(jobs: JobRecord[]): { adopted: string[]; lost: string[] } {
  const adopted: string[] = [];
  const lost: string[] = [];
  for (const job of jobs) {
    if (!ACTIVE_STAGES.has(job.stage) || job.queueState?.queued) continue;
    if (workerLooksAlive(job.worker)) {
      adopted.push(job.id);
    } else if (job.worker) {
      lost.push(job.id);
    }
  }
  return { adopted, lost };
}

export async function inspectRestartState(config: RunnerConfig): Promise<RestartPrepareResult> {
  const jobs = await listJobs(config.dataDir);
  const { adopted, lost } = adoptableJobs(jobs);
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

export type GracefulRestartOpts = {
  engine: RunnerEngine;
  closeHttp: () => Promise<void>;
  exit?: (code: number) => void;
};

export async function gracefulRunnerRestart(opts: GracefulRestartOpts): Promise<RestartPrepareResult> {
  const preview = await inspectRestartState(opts.engine.config);
  await opts.closeHttp();
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  exit(0);
  return preview;
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
