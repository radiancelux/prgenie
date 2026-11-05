export type JobStage =
  | "building"
  | "reviewing"
  | "fixing"
  | "approved"
  | "changes_remaining"
  | "stuck"
  | "failed"
  | "stopped";

export interface JobInput {
  repoPath: string;
  branch: string;
  promptFile: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
  maxRounds?: number;
  model?: string;
  /** Clone URL instead of local repoPath when set. */
  remote?: string;
  ticketUrl?: string;
  linearIssue?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type CiRollupStatus =
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "unknown"
  | "merged"
  | "merge_conflict"
  | "closed";

export interface CiStatusInfo {
  status: CiRollupStatus;
  summary?: string;
  checkedAt: string;
  checksUrl?: string;
  /** Set when GitHub reports the PR merged (ISO 8601). */
  mergedAt?: string | null;
  /** First-line gh/origin stderr when lookup fails (no secrets). */
  reason?: string;
  /** Origin `origin pr checks` when reachable; otherwise GitHub Actions rollup via `gh`. */
  source: "origin" | "github";
}

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  stage: JobStage;
  reviewRound: number;
  maxRounds: number;
  model: string;
  worktreePath: string | null;
  repoSlug: string;
  prUrl: string | null;
  prNumber: number | null;
  linearIssue: string | null;
  ticketUrl: string | null;
  tokenUsage: TokenUsage | null;
  ciStatus: CiStatusInfo | null;
  lastVerdict: "APPROVE" | "CHANGES" | null;
  error: string | null;
  logPath: string;
  steerQueue: string[];
  stopRequested: boolean;
  dryRun: boolean;
  /** Legacy field; merge visibility uses ciStatus.mergedAt + MERGED_HIDE_AFTER_MS. */
  archivedAt: string | null;
}

export interface StartJobArgs {
  repoPath?: string;
  remote?: string;
  branch: string;
  promptFile: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
  maxRounds?: number;
  model?: string;
  dryRun?: boolean;
  ticketUrl?: string;
  linearIssue?: string;
}

export type JobEvent =
  | { type: "stage"; stage: JobStage; reviewRound: number }
  | { type: "log"; line: string }
  | { type: "pr"; url: string }
  | { type: "done"; stage: JobStage };
