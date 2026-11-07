export type JobStage =
  | "building"
  | "reviewing"
  | "fixing"
  | "approved"
  | "changes_remaining"
  | "stuck"
  | "failed"
  | "stopped";

export type JobProfile = "code" | "docs";

export interface JobInput {
  repoPath: string;
  branch: string;
  promptFile: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
  maxRounds?: number;
  model?: string;
  /** Agent driver id (cursor-agent, claude-code, local-model, …). */
  driver?: string;
  /** Clone URL instead of local repoPath when set. */
  remote?: string;
  ticketUrl?: string;
  linearIssue?: string;
  /** `docs` worktrees a business/policy repo; default is code. */
  jobType?: JobProfile;
  /** Alias for jobType (MCP / dashboard). */
  profile?: JobProfile;
  /** Built-in docs template when jobType is docs. */
  docsTemplate?: "marketing" | "policy" | "research";
  /** Human label for dashboard rows (derived at create when omitted). */
  title?: string;
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

export interface DocLintFinding {
  file: string;
  line: number;
  column?: number;
  rule: string;
  message: string;
}

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
  source: "origin" | "github" | "doc-checks";
  /** Structured markdownlint findings (docs jobs / doc-checks source). */
  findings?: DocLintFinding[];
  /** True when more than {@link DOC_LINT_FINDINGS_CAP} findings were emitted by the linter. */
  findingsTruncated?: boolean;
}

/** Generous cap for persisted doc lint findings (see local-runner README). */
export const DOC_LINT_FINDINGS_CAP = 250;

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  stage: JobStage;
  reviewRound: number;
  maxRounds: number;
  model: string;
  driverId: string;
  worktreePath: string | null;
  repoSlug: string;
  prUrl: string | null;
  prNumber: number | null;
  /** Cached from GitHub isDraft; dashboard Draft/Ready pill. */
  prIsDraft: boolean | null;
  /** HEAD SHA when runner recorded VERDICT: APPROVE. */
  approveHeadSha: string | null;
  /** ISO timestamp after successful \`gh pr ready\` (idempotent). */
  readyPromotedAt: string | null;
  linearIssue: string | null;
  ticketUrl: string | null;
  /** Base title for agent row (without Linear issue prefix). */
  title: string;
  tokenUsage: TokenUsage | null;
  ciStatus: CiStatusInfo | null;
  lastVerdict: "APPROVE" | "CHANGES" | null;
  error: string | null;
  logPath: string;
  steerQueue: string[];
  stopRequested: boolean;
  dryRun: boolean;
  /** Set while the job lives under `archived/` (dashboard Remove / MCP archive_job); null when live. */
  archivedAt: string | null;
}

export interface StartJobArgs {
  repoPath?: string;
  remote?: string;
  branch: string;
  promptFile?: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
  maxRounds?: number;
  model?: string;
  driver?: string;
  dryRun?: boolean;
  ticketUrl?: string;
  linearIssue?: string;
  jobType?: JobProfile;
  profile?: JobProfile;
  docsTemplate?: JobInput["docsTemplate"];
  /** Human label for dashboard rows (derived at create when omitted). */
  title?: string;
}

export type JobEvent =
  | { type: "stage"; stage: JobStage; reviewRound: number }
  | { type: "log"; line: string }
  | { type: "pr"; url: string }
  | { type: "done"; stage: JobStage };
