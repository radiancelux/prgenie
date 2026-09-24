/**
 * RAD-100 — keep Cursor MCP sessions alive during long git/CI tool calls.
 *
 * Hosts that honor `notifications/progress` (with `resetTimeoutOnProgress`) and/or
 * a raised `mcp.json` `timeout` stop dying with JSON-RPC `-32001 Request timed out`
 * while list/get/run_ci/export/gh_status (and siblings) still work.
 */

import type { ProgressEvent } from "@prgenie/core";
import { formatProgressLine, looksLikeStaleFullSuitePlan } from "@prgenie/core";

type Json = Record<string, unknown>;

/**
 * Cursor/community mcp.json timeout field (seconds). Match CI default wall (~20m).
 * Keep in sync with `MCP_SERVER_TIMEOUT_SEC` in `@prgenie/core` (`plugin-mcp.ts`).
 */
export const MCP_SERVER_TIMEOUT_SEC = 1_200;

/** Heartbeat cadence while a heavy tool has not yet returned (ms). */
export const MCP_HEARTBEAT_INTERVAL_MS = 15_000;

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
 * Start heartbeats + optional MCP progress notifications for one tools/call.
 * Always emits logging notifications so Output → MCP Logs stays alive even when
 * the client omitted `_meta.progressToken`.
 */
export function startMcpProgressSession(opts: {
  notify: McpNotify;
  toolName: string;
  progressToken?: string | number;
  heartbeatMs?: number;
  now?: () => number;
}): McpProgressSession {
  const heartbeatMs = opts.heartbeatMs ?? MCP_HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  let ticks = 0;
  let stopped = false;

  const emit = (message: string, progress?: number, total?: number): void => {
    if (stopped) return;
    const elapsedSec = Math.max(0, Math.round((now() - started) / 1000));
    const data = `[prgenie] ${opts.toolName}: ${message} (${elapsedSec}s)`;
    opts.notify("notifications/message", { level: "info", data });
    if (opts.progressToken !== undefined) {
      const params: Json = {
        progressToken: opts.progressToken,
        progress: progress ?? ticks,
        message: data,
      };
      if (total !== undefined) params.total = total;
      opts.notify("notifications/progress", params);
    }
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
      stopped = true;
      clearInterval(timer);
      emit("done", ticks);
    },
  };
}

/** Run `fn` under a heavy-tool progress session (start + heartbeat + stop). */
export async function withMcpProgress<T>(
  opts: {
    notify: McpNotify;
    toolName: string;
    progressToken?: string | number;
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
