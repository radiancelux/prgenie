/**
 * RAD-100 / RAD-128 — keep Cursor MCP sessions alive during long git/CI tool calls.
 *
 * Heartbeats use `notifications/message` (safe). `notifications/progress` is
 * **opt-in only** (`PRGENIE_MCP_PROGRESS=1`): Cursor Shared MCP treats an unknown
 * `progressToken` as fatal (`transport_error` → disconnect), so defaulting progress
 * on kills sessions. Keep the raised `mcp.json` `timeout` pin either way.
 */

import type { ProgressEvent } from "@prgenie/core";
import {
  formatProgressLine,
  looksLikeStaleFullSuitePlan,
  MCP_SERVER_TIMEOUT_SEC,
} from "@prgenie/core";

type Json = Record<string, unknown>;

export { MCP_SERVER_TIMEOUT_SEC };

/** Heartbeat cadence while a heavy tool has not yet returned (ms). */
export const MCP_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Env opt-in for `notifications/progress` (RAD-128). Default off — message
 * heartbeats alone keep the session alive without unknown-token disconnects.
 */
export const MCP_PROGRESS_ENV = "PRGENIE_MCP_PROGRESS";

/** True when `PRGENIE_MCP_PROGRESS` is `1` / `true` / `yes` (case-insensitive). */
export function isMcpProgressOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MCP_PROGRESS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Soft guidance for steward Task fan-out (docs only). Product concurrency
 * guardrails / batching are RAD-84 — do not enforce here.
 */
export const RECOMMENDED_MAX_PARALLEL_IMPLEMENTOR_TASKS = 2;

/** Git/CI-heavy tools (+ siblings) that need raised timeout + progress/heartbeats. */
export const MCP_HEAVY_TOOLS = new Set([
  "list_local_prs",
  "get_local_pr",
  "run_ci",
  "export_local_pr",
  "gh_status",
  "github_status",
  "shepherd_status",
  "steward_next",
  "ensure_worktree",
  "get_diff",
  "get_local_pr_name_status",
  "create_local_pr",
  "attach_local_pr",
  "claim_review",
  "run_preflight",
  "abort_ci",
]);

export function isMcpHeavyTool(name: string): boolean {
  return MCP_HEAVY_TOOLS.has(name);
}

export function extractProgressToken(params: Json): string | number | undefined {
  const meta = params._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const token = (meta as Json).progressToken;
  if (typeof token === "string" || typeof token === "number") return token;
  return undefined;
}

/**
 * Refuse a stale root full-suite plan at the MCP boundary (RAD-100 / RAD-119).
 * Core `runLoopCi` / shepherd already refuse; this fails fast before a silent hang.
 */
export function assertMcpCiPlanNotFullSuite(selection: {
  checks?: string[];
  reason?: string[];
}): void {
  if (!looksLikeStaleFullSuitePlan(selection)) return;
  throw new Error(
    `MCP refusing full-suite CI plan without scoped progress (RAD-100 / RAD-119): ` +
      `checks=${JSON.stringify(selection.checks ?? [])} ` +
      `reason=${JSON.stringify(selection.reason ?? [])}. ` +
      `Use worktree selectCiChecks (package/path-scoped) — never root pnpm lint/test/turbo.`,
  );
}

export type McpNotify = (method: string, params?: Json) => void;

export type McpProgressSession = {
  report: (message: string, progress?: number, total?: number) => void;
  onCiProgress: (event: ProgressEvent) => void;
  stop: () => void;
};

/**
 * Start heartbeats (+ optional MCP progress) for one tools/call.
 * Always emits `notifications/message` so Output → MCP Logs stays alive even when
 * the client omitted `_meta.progressToken`. Progress is off unless
 * {@link isMcpProgressOptIn} (or `enableProgress: true` in tests).
 */
export function startMcpProgressSession(opts: {
  notify: McpNotify;
  toolName: string;
  progressToken?: string | number;
  /** Override env opt-in (tests). Default: {@link isMcpProgressOptIn}. */
  enableProgress?: boolean;
  heartbeatMs?: number;
  now?: () => number;
}): McpProgressSession {
  const heartbeatMs = opts.heartbeatMs ?? MCP_HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const progressEnabled = opts.enableProgress ?? isMcpProgressOptIn();
  let ticks = 0;
  let stopped = false;

  const emitMessage = (message: string): void => {
    const elapsedSec = Math.max(0, Math.round((now() - started) / 1000));
    const data = `[prgenie] ${opts.toolName}: ${message} (${elapsedSec}s)`;
    opts.notify("notifications/message", { level: "info", data });
  };

  const emitProgress = (message: string, progress?: number, total?: number): void => {
    if (!progressEnabled || opts.progressToken === undefined) return;
    const elapsedSec = Math.max(0, Math.round((now() - started) / 1000));
    const data = `[prgenie] ${opts.toolName}: ${message} (${elapsedSec}s)`;
    const params: Json = {
      progressToken: opts.progressToken,
      progress: progress ?? ticks,
      message: data,
    };
    if (total !== undefined) params.total = total;
    opts.notify("notifications/progress", params);
  };

  const emit = (message: string, progress?: number, total?: number): void => {
    if (stopped) return;
    emitMessage(message);
    emitProgress(message, progress, total);
  };

  emit("started");

  const timer = setInterval(() => {
    ticks += 1;
    emit("still working", ticks);
  }, heartbeatMs);
  // Do not keep the MCP process alive solely for heartbeats after the tool returns.
  timer.unref?.();

  return {
    report: (message, progress, total) => {
      ticks += 1;
      emit(message, progress ?? ticks, total);
    },
    onCiProgress: (event) => {
      ticks += 1;
      emit(formatProgressLine(event), ticks);
    },
    stop: () => {
      if (stopped) return;
      clearInterval(timer);
      // Mark settled before the final tick so no progress can race tools/call
      // return (unknown-token disconnect — RAD-128). Message "done" still fires.
      stopped = true;
      emitMessage("done");
    },
  };
}

/** Run `fn` under a heavy-tool progress session (start + heartbeat + stop). */
export async function withMcpProgress<T>(
  opts: {
    notify: McpNotify;
    toolName: string;
    progressToken?: string | number;
    enableProgress?: boolean;
    heartbeatMs?: number;
  },
  fn: (session: McpProgressSession) => Promise<T>,
): Promise<T> {
  const session = startMcpProgressSession(opts);
  try {
    return await fn(session);
  } finally {
    session.stop();
  }
}
