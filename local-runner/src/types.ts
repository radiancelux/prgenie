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

export type CiRollupStatus = "pending" | "success" | "failure" | "neutral" | "unknown";

export interface CiStatusInfo {
  status: CiRollupStatus;
  summary?: string;
  checkedAt: string;
  checksUrl?: string;
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
  /** Set when the linked PR is merged — hidden from default list; CI polling stops. */
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
