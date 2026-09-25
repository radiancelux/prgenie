import { spawn, spawnSync } from "node:child_process";
import { abortError } from "./progress.js";

/** After kill, wait this long for stdout/stderr pipes to close before forcing finish. */
export const PIPE_CLOSE_WAIT_MS = 5000;

export type KillTreeResult = { ok: true } | { ok: false; reason: string };

function killErrCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return code != null ? String(code) : undefined;
}

/** Match Windows taskkill "not found": process already exited is success, not a failed kill. */
function isProcessAlreadyDead(err: unknown): boolean {
  return killErrCode(err) === "ESRCH";
}

function taskkillWindows(pid: number): KillTreeResult {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status === 0) return { ok: true };
  const stderr = (result.stderr ?? "").trim();
  const alreadyGone =
    /not found|no running instance|not running|no tasks running/i.test(stderr) ||
    result.status === 128;
  if (alreadyGone) return { ok: true };
  const reason = stderr || result.error?.message || `exit ${result.status ?? "unknown"}`;
  return { ok: false, reason };
}

/**
 * Kill a spawned CI shell and all descendants.
 *
 * - **Windows:** `taskkill /PID <pid> /T /F` tears down cmd.exe, pnpm, tsx, and node test workers.
 * - **POSIX:** spawn uses `detached: true`; kill the process group with `SIGKILL` on `-pid`.
 *
 * stderr from taskkill is captured and never inherited by the parent process.
 */
export function killProcessTree(pid: number | undefined): KillTreeResult {
  if (!pid || pid <= 0) return { ok: true };
  if (process.platform === "win32") {
    return taskkillWindows(pid);
  }
  try {
    process.kill(-pid, "SIGKILL");
    return { ok: true };
  } catch (err) {
    if (isProcessAlreadyDead(err)) return { ok: true };
    try {
      process.kill(pid, "SIGKILL");
      return { ok: true };
    } catch (inner) {
      if (isProcessAlreadyDead(inner)) return { ok: true };
      const reason =
        inner instanceof Error ? inner.message : err instanceof Error ? err.message : "kill failed";
      return { ok: false, reason };
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
  /** Kill-tree or pipe-drain notes surfaced in progress and failure logs. */
  readonly notes: string[];

  constructor(input: {
    message: string;
    kind: CiShellFailureKind;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timeoutMs?: number;
    notes?: string[];
  }) {
    super(input.message);
    this.name = "CiShellError";
    this.kind = input.kind;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
    this.exitCode = input.exitCode;
    this.timeoutMs = input.timeoutMs;
    this.notes = input.notes ?? [];
  }
}

export interface ExecCiShellOptions {
  command: string;
  cwd: string;
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Override pipe-drain wait (tests only). */
  pipeCloseWaitMs?: number;
  /** Override tree kill (tests only). */
  killProcessTreeFn?: (pid: number | undefined) => KillTreeResult;
}

/** Match child_process.exec: maxBuffer applies per stream, not stdout+stderr combined. */
function appendChunk(
  current: string,
  chunk: Buffer,
  streamBytes: { value: number },
  maxBuffer: number,
): { text: string; exceeded: boolean } {
  streamBytes.value += chunk.length;
  if (streamBytes.value > maxBuffer) {
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
  const pipeCloseWaitMs = options.pipeCloseWaitMs ?? PIPE_CLOSE_WAIT_MS;
  const killTreeFn = options.killProcessTreeFn ?? killProcessTree;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let stdout = "";
    let stderr = "";
    const stdoutBytes = { value: 0 };
    const stderrBytes = { value: 0 };
    let timedOut = false;
    let cancelled = false;
    let maxBufferExceeded = false;
    let settled = false;
    const killNotes: string[] = [];
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pipeDrainTimer) clearTimeout(pipeDrainTimer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const rejectWithNotes = (shellErr: CiShellError): void => {
      reject(
        new CiShellError({
          message: shellErr.message,
          kind: shellErr.kind,
          stdout: shellErr.stdout,
          stderr: shellErr.stderr,
          exitCode: shellErr.exitCode,
          timeoutMs: shellErr.timeoutMs,
          notes: killNotes.length ? [...killNotes] : shellErr.notes,
        }),
      );
    };

    const forceFinishOpenPipes = (): void => {
      if (settled) return;
      killNotes.push("pipes still open after kill; destroyed streams — descendants may survive");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(() => {
        if (cancelled || signal?.aborted) {
          rejectWithNotes(
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
          rejectWithNotes(
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
          rejectWithNotes(
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
        rejectWithNotes(
          new CiShellError({
            kind: "exit",
            message: `Command failed: ${command}`,
            stdout,
            stderr,
            exitCode: 1,
          }),
        );
      });
    };

    const schedulePipeDrain = (): void => {
      if (pipeDrainTimer) clearTimeout(pipeDrainTimer);
      pipeDrainTimer = setTimeout(forceFinishOpenPipes, pipeCloseWaitMs);
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
    killTree = () => {
      const result = killTreeFn(child.pid);
      if (!result.ok) {
        killNotes.push(`tree kill incomplete: ${result.reason}`);
      }
      schedulePipeDrain();
    };

    child.on("error", (err) => {
      finish(() => {
        reject(
          new CiShellError({
            kind: "spawn",
            message: err.message,
            stdout,
            stderr,
            notes: killNotes,
          }),
        );
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendChunk(stdout, chunk, stdoutBytes, maxBuffer);
      stdout = next.text;
      if (next.exceeded && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killTree();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendChunk(stderr, chunk, stderrBytes, maxBuffer);
      stderr = next.text;
      if (next.exceeded && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killTree();
      }
    });

    child.on("close", (code) => {
      finish(() => {
        if (cancelled || signal?.aborted) {
          rejectWithNotes(
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
          rejectWithNotes(
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
          rejectWithNotes(
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
              notes: killNotes,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}
