export type ProgressPhase = "review" | "preflight" | "github" | "ci" | "push" | "create_pr";
export type ProgressState = "start" | "pass" | "fail" | "skip" | "cached";
export type ProgressKind = "gate" | "export";

export interface ProgressEvent {
  phase: ProgressPhase;
  /** CI check name (format:check, lint, typecheck, test, build). */
  check?: string;
  state: ProgressState;
  elapsedMs?: number;
  /** User-facing command, e.g. `pnpm test` or `git push`. */
  command?: string;
  /** Short failure excerpt (RAD-74). */
  message?: string;
  /** Capped full log path when a CI check failed. */
  logPath?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface RunProgressOptions {
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export function ciCheckCommand(check: string): string {
  return `pnpm ${check}`;
}

export function abortError(message = "Cancelled"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    fn();
    return () => undefined;
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

export function shortCheckName(check: string): string {
  return check === "format:check" ? "format" : check;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatProgressLine(event: ProgressEvent): string {
  const label = event.check ? `${event.phase}:${event.check}` : event.phase;
  if (event.state === "start") {
    const cmd = event.command ? ` (${event.command})` : "";
    return `[${label}] running${cmd}...`;
  }
  if (event.state === "skip") {
    return `[${label}] skip`;
  }
  const elapsed = event.elapsedMs != null ? ` (${formatElapsed(event.elapsedMs)})` : "";
  if (event.state === "cached") {
    return `[${label}] cached${elapsed}`;
  }
  if (event.state === "fail") {
    const cmd = event.command ? ` — ${event.command}` : "";
    const msg = event.message && event.message !== event.command ? ` — ${event.message}` : "";
    return `[${label}] fail${elapsed}${cmd}${msg}`;
  }
  return `[${label}] pass${elapsed}`;
}

/** Sidebar step: gate = "CI checks → test"; export = "CI → push → create PR". */
export function formatProgressStep(event: ProgressEvent, kind: ProgressKind = "gate"): string {
  if (kind === "export") {
    if (event.phase === "create_pr") return "CI → push → create PR";
    if (event.phase === "push") return "CI → push";
    if (event.phase === "ci") {
      return event.check ? `CI → ${shortCheckName(event.check)}` : "CI";
    }
    if (event.phase === "review") return "CI → review";
    if (event.phase === "preflight") return "CI → preflight";
    if (event.phase === "github") return "CI → GitHub";
    return "CI";
  }
  if (event.phase === "ci") {
    return event.check ? `CI checks → ${shortCheckName(event.check)}` : "CI checks";
  }
  if (event.phase === "review") return "Review";
  if (event.phase === "preflight") return "Preflight";
  if (event.phase === "github") return "GitHub bind";
  if (event.phase === "push") return "Push";
  return "Create PR";
}

export function formatFailedCheck(
  event: Pick<ProgressEvent, "check" | "command" | "message" | "logPath">,
): string {
  const name = event.check ? shortCheckName(event.check) : "check";
  const command = event.command ? ` — ${event.command}` : "";
  const extra =
    event.message && event.message !== event.command && !event.message.includes(event.command ?? "")
      ? ` — ${event.message}`
      : event.message && event.message !== event.command
        ? ` — ${event.message}`
        : "";
  const log = event.logPath ? ` — full log: ${event.logPath}` : "";
  return `${name}${command}${extra}${log}`;
}
