export type ProgressPhase = "review" | "preflight" | "github" | "ci" | "push" | "create_pr";
export type ProgressState = "start" | "pass" | "fail" | "skip" | "cached";
export type ProgressKind = "gate" | "export";

export type CiCheckProgressState = ProgressState | "queued" | "cancelled";

export interface CiCheckProgress {
  name: string;
  state: CiCheckProgressState;
  elapsedMs?: number;
  command?: string;
  message?: string;
  logPath?: string;
  reason?: string;
}

export interface CiProgressSnapshot {
  selectedChecks: string[];
  selectionReason: string;
  checks: CiCheckProgress[];
  /** Path CI ran / is running in (RAD-112). */
  cwd?: string;
}

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
  /** Smart-CI plan (RAD-77) — which checks and why. */
  selectedChecks?: string[];
  selectionReason?: string;
  /** Path CI is running in (RAD-112). */
  cwd?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface RunProgressOptions {
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

/**
 * Map a smart-CI check name to a default shell command.
 * Package-scoped names (`lint:core`, `test:cli`, …) never expand to root `pnpm test`.
 * Host-repo monorepo-wide scripts (`eslint .`) are rewritten by
 * `resolveCiCheckCommand` in `ci-host-scope.ts` so the progress card can show
 * `eslint path1 path2` instead of bare `pnpm lint`.
 */
export function ciCheckCommand(check: string): string {
  const scoped = check.match(/^(lint|typecheck|test|build):(core|cli|extension)$/);
  if (scoped) {
    const [, kind, pkg] = scoped;
    const dir = `packages/${pkg}`;
    if (kind === "lint") return `pnpm exec eslint ${dir}/src`;
    if (kind === "typecheck") return `pnpm exec tsc -p ${dir} --noEmit`;
    // Flat src/*.test.ts — cmd.exe expands `*` (directory form breaks under tsx on Windows).
    if (kind === "test") return `pnpm exec tsx --test ${dir}/src/*.test.ts`;
    if (kind === "build") return `pnpm exec node scripts/build.mjs`;
  }
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

export function emptyCiProgressSnapshot(): CiProgressSnapshot {
  return { selectedChecks: [], selectionReason: "", checks: [] };
}

export function applyCiProgressEvent(
  current: CiProgressSnapshot,
  event: ProgressEvent,
): CiProgressSnapshot {
  const selectedChecks = event.selectedChecks ?? current.selectedChecks;
  const selectionReason = event.selectionReason ?? current.selectionReason;
  const cwd = event.cwd ?? current.cwd;
  const checks = current.checks.map((c) => ({ ...c }));
  const ensure = (name: string): CiCheckProgress => {
    const existing = checks.find((c) => c.name === name);
    if (existing) return existing;
    const created: CiCheckProgress = { name, state: "queued" };
    checks.push(created);
    return created;
  };
  if (event.selectedChecks) {
    for (const name of event.selectedChecks) ensure(name);
  }
  if (event.phase === "ci" && event.check) {
    const row = ensure(event.check);
    row.state = event.state;
    if (event.elapsedMs != null) row.elapsedMs = event.elapsedMs;
    if (event.command) row.command = event.command;
    if (event.message) row.message = event.message;
    if (event.logPath) row.logPath = event.logPath;
  }
  return { selectedChecks, selectionReason, checks, cwd };
}

/** Agent-chat / CLI card: selected checks, why, running/pass/fail, elapsed. */
export function createProgressCardSink(write: (line: string) => void): {
  onProgress: ProgressCallback;
  snapshot: () => CiProgressSnapshot;
  card: () => string;
} {
  let snap = emptyCiProgressSnapshot();
  return {
    onProgress: (event) => {
      snap = applyCiProgressEvent(snap, event);
      write(formatProgressLine(event));
    },
    snapshot: () => snap,
    card: () => formatProgressCard(snap),
  };
}

export function formatProgressCard(snapshot: CiProgressSnapshot): string {
  const why = snapshot.selectionReason
    ? `Why: ${snapshot.selectionReason}`
    : "Why: configured suite";
  const lines = ["CI progress", why];
  if (snapshot.cwd) {
    lines.push(`Cwd: ${snapshot.cwd}`);
  }
  const names =
    snapshot.selectedChecks.length > 0
      ? snapshot.selectedChecks
      : snapshot.checks.map((c) => c.name);
  if (names.length === 0) {
    lines.push("  (no checks yet — waiting to start)");
    return lines.join("\n");
  }
  for (const name of names) {
    const row = snapshot.checks.find((c) => c.name === name);
    const state = row?.state ?? "queued";
    const elapsed = row?.elapsedMs != null ? ` ${formatElapsed(row.elapsedMs)}` : "";
    const extra =
      state === "fail" && row?.message
        ? ` — ${row.message}`
        : state === "start" && row?.command
          ? ` (${row.command})`
          : "";
    lines.push(`  ${shortCheckName(name).padEnd(10)} ${state}${elapsed}${extra}`);
  }
  return lines.join("\n");
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
