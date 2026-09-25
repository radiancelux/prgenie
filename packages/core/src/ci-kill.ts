import { execFileSync, spawn } from "node:child_process";
import { abortError } from "./progress.js";

/**
 * Kill a spawned CI shell and all descendants.
 *
 * - **Windows:** `taskkill /PID <pid> /T /F` tears down cmd.exe, pnpm, tsx, and node test workers.
 * - **POSIX:** spawn uses `detached: true`; kill the process group with `SIGKILL` on `-pid`.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // Process already exited.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

export type CiShellFailureKind = "timeout" | "cancelled" | "maxBuffer" | "spawn" | "exit";

export class CiShellError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly kind: CiShellFailureKind;
  readonly exitCode?: number;
  readonly timeoutMs?: number;

  constructor(input: {
    message: string;
    kind: CiShellFailureKind;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timeoutMs?: number;
  }) {
    super(input.message);
    this.name = "CiShellError";
    this.kind = input.kind;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
    this.exitCode = input.exitCode;
    this.timeoutMs = input.timeoutMs;
  }
}

export interface ExecCiShellOptions {
  command: string;
  cwd: string;
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function appendChunk(
  current: string,
  chunk: Buffer,
  totalBytes: { value: number },
  maxBuffer: number,
): { text: string; exceeded: boolean } {
  totalBytes.value += chunk.length;
  if (totalBytes.value > maxBuffer) {
    return { text: current, exceeded: true };
  }
  return { text: current + chunk.toString("utf8"), exceeded: false };
}

/**
 * Run one CI shell command with timeout, cancel, and maxBuffer handling.
 * Always kills the process tree on timeout or abort so tsx/node workers cannot outlive the parent.
 */
export function execCiShell(
  options: ExecCiShellOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { command, cwd, timeout, maxBuffer, env, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let stdout = "";
    let stderr = "";
    const totalBytes = { value: 0 };
    let timedOut = false;
    let cancelled = false;
    let maxBufferExceeded = false;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    let killTree: () => void = () => undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);

    const onAbort = (): void => {
      cancelled = true;
      killTree();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    killTree = () => killProcessTree(child.pid);

    child.on("error", (err) => {
      finish(() => {
        reject(
          new CiShellError({
            kind: "spawn",
            message: err.message,
            stdout,
            stderr,
          }),
        );
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendChunk(stdout, chunk, totalBytes, maxBuffer);
      stdout = next.text;
      if (next.exceeded && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killTree();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendChunk(stderr, chunk, totalBytes, maxBuffer);
      stderr = next.text;
      if (next.exceeded && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killTree();
      }
    });

    child.on("close", (code) => {
      finish(() => {
        if (cancelled || signal?.aborted) {
          reject(
            new CiShellError({
              kind: "cancelled",
              message: "Cancelled",
              stdout,
              stderr,
            }),
          );
          return;
        }
        if (maxBufferExceeded) {
          reject(
            new CiShellError({
              kind: "maxBuffer",
              message: "maxBuffer exceeded",
              stdout,
              stderr,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new CiShellError({
              kind: "timeout",
              message: `Command timed out after ${timeout}ms`,
              stdout,
              stderr,
              timeoutMs: timeout,
            }),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new CiShellError({
              kind: "exit",
              message: `Command failed: ${command}`,
              stdout,
              stderr,
              exitCode: code ?? 1,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}
