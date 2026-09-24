export type LocalPrStatus =
  "draft" | "ready" | "review_interrupted" | "changes_requested" | "reviewed" | "approved";

/** Last implementor CI result for soft-blocking ready (RAD-97). */
export type ReadyCiOutcome = "passed" | "skipped";

export interface ReadyCiRecord {
  headSha: string;
  recordedAt: string;
  outcome: ReadyCiOutcome;
  /** Present when outcome is skipped — body form is "CI skipped: <reason>". */
  skipReason?: string | null;
  checks?: string[];
}

export type CommentRole = "human" | "agent" | "reviewer";

/** Finding lifecycle: agent addresses, reviewer resolves. */
export type CommentStatus = "open" | "addressed" | "resolved";

export interface LocalPrComment {
  id: string;
  body: string;
  createdAt: string;
  author: string;
  role: CommentRole;
  status: CommentStatus;
  path?: string;
  line?: number;
  side?: "left" | "right";
  replyTo?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** HEAD sha this review-request root was upserted for (RAD-97 dedupe). */
  forSha?: string;
}

export interface CommentThread {
  root: LocalPrComment;
  replies: LocalPrComment[];
}

export interface LocalPrSource {
  kind: "subagent" | "cli" | "extension";
  subagentType?: string;
  subagentId?: string;
  task?: string;
}

export interface LocalPr {
  id: string;
  title: string;
  body: string;
  status: LocalPrStatus;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  worktreePath: string | null;
  comments: LocalPrComment[];
  source: LocalPrSource | null;
  createdAt: string;
  updatedAt: string;
  /** HEAD sha recorded when the loop became ready — drift baseline for complete_review. */
  reviewRequestedSha: string | null;
  /** HEAD sha we last told the implementor chat to spawn a reviewer for (once per HEAD). */
  reviewerNotifiedSha: string | null;
  /**
   * Last implementor `run_ci` / explicit skip for this tip (RAD-97).
   * Soft-blocks `set_status ready` until passed or skipped for current headSha.
   */
  readyCi?: ReadyCiRecord | null;
  /**
   * Last full shepherd/export-gate snapshot (review + preflight + gh + CI).
   * Human-exportable UI is fail-closed: missing/stale/pending is not exportable.
   */
  exportGate?: ExportGateSnapshot | null;
}

export type ExportGateStatus = "ready" | "blocked" | "pending";

export type ExportGateCheck = "review" | "preflight" | "github" | "ci";

export interface ExportGateReason {
  check: ExportGateCheck;
  message: string;
}

export interface ExportGateCiCheck {
  name: string;
  passed: boolean;
  skipped?: boolean;
  excerpt?: string;
  logPath?: string;
  elapsedMs?: number;
  reason?: string;
}

export interface ExportGateCiPlan {
  checks: string[];
  /** Selection reasons (RAD-105); may be a legacy single string when read from disk. */
  reason: string[];
  uncertain?: boolean;
}

/** Persisted shepherd result used to gate Push to origin / export. */
export interface ExportGateSnapshot {
  status: ExportGateStatus;
  reasons: ExportGateReason[];
  headSha: string;
  evaluatedAt: string | null;
  /** Smart-CI selection shown in the panel + chat card. */
  ciPlan?: ExportGateCiPlan | null;
  /** Per-check results for the breakout modal (RAD-74 excerpt/log). */
  ciChecks?: ExportGateCiCheck[] | null;
  /** Path local CI ran in (RAD-112). */
  ciCwd?: string | null;
  /** Soft CI env/toolchain problem (RAD-92 / RAD-95) — first-class, not skipValidation-only. */
  ciEnvUnhealthy?: { message: string; fixSteps?: string[] } | null;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export interface CreateLocalPrInput {
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  source?: LocalPrSource;
}

export interface CaptureResult {
  action: "created" | "updated" | "skipped";
  reason?: string;
  pr?: LocalPr;
}

export const STATUSES: LocalPrStatus[] = [
  "draft",
  "ready",
  "review_interrupted",
  "changes_requested",
  "reviewed",
  "approved",
];

export const COMMENT_ROLES: CommentRole[] = ["human", "agent", "reviewer"];

export const COMMENT_STATUSES: CommentStatus[] = ["open", "addressed", "resolved"];

export interface Learning {
  id: string;
  pattern: string;
  guidance: string;
  sourceCommentId: string;
  sourcePrId: string;
  createdAt: string;
  learnedAt: string;
  disabled: boolean;
  path?: string;
  category?: string;
}

export interface PreflightIssue {
  learningId: string;
  pattern: string;
  guidance: string;
  matchedIn: "diff" | "title" | "body";
  path?: string;
}

export interface PreflightResult {
  passed: boolean;
  issues: PreflightIssue[];
}
