import { spawn } from "node:child_process";

export type GhResult = { code: number; stdout: string; stderr: string };

/** Spawn a CLI; never rejects — ENOENT and other spawn errors resolve as code 1. */
export function spawnCommand(cmd: string, cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (!stderr) stderr = err.message;
      else stderr += `\n${err.message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}
