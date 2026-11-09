export type JobStage =
  | "building"
  | "reviewing"
  | "fixing"
  | "approved"
  | "changes_remaining"
  | "stuck"
  | "failed"
  | "stopped"
  | "interrupted";

export type JobWorkerState = {
  pid: number;
  hostname: string;
  startedAt: string;
  /** Random per-claim id; release only clears a claim whose token matches. */
  token?: string;
  /** OS process start time (`/proc/<pid>/stat` field 22, or `ps lstart`); guards PID reuse. */
  procStartTime?: string | null;
};

export type JobProfile = "code" | "docs" | "compute";

export type JobStageModelKey = "build" | "review" | "fix";

export type JobStageModels = Record<JobStageModelKey, string>;

export type JobStageModelsInput = Partial<JobStageModels>;

export interface JobInput {
  repoPath: string;
  branch: string;
  promptFile: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
  maxRounds?: number;
  /** Legacy single-model override (all stages). */
  model?: string;
  /** Per-stage model overrides at job creation. */
  stageModels?: JobStageModelsInput;
  /** Agent driver id (cursor-agent, claude-code, local-model, …). */
  driver?: string;
  /** Clone URL instead of local repoPath when set. */
  remote?: string;
  ticketUrl?: string;
  /** Extra tickets the job covers (http(s) links). */
  ticketUrls?: string[];
  linearIssue?: string;
  /** `docs` worktrees a business/policy repo; default is code. */
  jobType?: JobProfile;
  /** Alias for jobType (MCP / dashboard). */
  profile?: JobProfile;
  /** Built-in docs template when jobType is docs. */
  docsTemplate?: "marketing" | "policy" | "research";
  /** Per-job watchdog override (frozen into effectiveSnapshot at creation). */
  watchdog?: {
    inactivityMs?: number;
    stageCapMs?: number;
    recoveryAttempts?: number;
  };
  /** Human label for dashboard rows (derived at create when omitted). */
  title?: string;
  /**
   * When false, a successful build with no GitHub PR finishes as approved (issues-only / audit jobs).
   * Default true: missing PR after build becomes stuck.
   */
  expectPr?: boolean;
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

export type WatchdogState = {
  lastActivityAt: string | null;
  stageStartedAt: string | null;
  recoveryAttemptsUsed: number;
  lastRecoveryAt: string | null;
  lastStallReason: string | null;
};

/** Live dashboard hints while a stage runs (cleared between stages). */
export type JobRuntimeState = {
  waitMode: "agent" | "command";
  command?: {
    summary: string;
    detail?: string;
    startedAt: string;
    processLabel?: string;
  };
};

export type JobQueueState = {
  queued: boolean;
  position?: number;
  since?: string;
};

export type JobContinueHistoryEntry = {
  at: string;
  extraRounds: number;
  priorMaxRounds: number;
  newMaxRounds: number;
  prompt: string | null;
  model: string | null;
  /** Set when an interrupted pre-PR job re-ran its build stage instead of a fix round. */
  resumedStage?: "building";
};

export type JobEffectiveSnapshot = {
  maxRounds: number;
  stageModels: JobStageModels;
  baseRef: string | null;
  watchdogInactivityMs: number;
  watchdogStageCapMs: number;
  watchdogRecoveryAttempts: number;
};

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  stage: JobStage;
  reviewRound: number;
  maxRounds: number;
  /** Legacy display field; build model at creation. */
  model: string;
  /** Resolved per-stage models snapshot at job creation. */
  stageModels?: JobStageModels;
  /** Driver-reported or observed model id per stage (when known). */
  stageModelActual?: Partial<JobStageModels>;
  effectiveSnapshot?: JobEffectiveSnapshot;
  watchdog?: WatchdogState;
  runtime?: JobRuntimeState | null;
  queueState?: JobQueueState;
  driverId: string;
  worktreePath: string | null;
  /**
   * Best-effort base ref (e.g. origin/main). For a reused worktree this is the first
   * resolvable probe ref, which may differ from the ref the branch was created from.
   */
  baseRef?: string | null;
  /** Best-effort tip SHA of {@link JobRecord.baseRef}; empty string when it could not be resolved. */
  baseSha?: string | null;
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
  /** Primary ticket; `ticketUrls` lists every ticket (primary first) when the job covers several. */
  ticketUrl: string | null;
  ticketUrls?: string[];
  /** Base title for agent row (without Linear issue prefix). */
  title: string;
  tokenUsage: TokenUsage | null;
  ciStatus: CiStatusInfo | null;
  lastVerdict: "APPROVE" | "CHANGES" | null;
  error: string | null;
  logPath: string;
  steerQueue: string[];
  stopRequested: boolean;
  /**
   * Detached `job-worker` process executing this job (survives HTTP server restart). Owned by
   * claim/release in `job-worker-lock.ts`; `saveJob` keeps the on-disk value unless set to `null`.
   */
  worker?: JobWorkerState | null;
  dryRun: boolean;
  /** Dry-run preflight gaps (#158); real jobs block before create. */
  preflightWarnings?: string[];
  /** Set while the job lives under `archived/` (dashboard Remove / MCP archive_job); null when live. */
  archivedAt: string | null;
  /** Extra fix→review rounds started via continue_job / POST continue. */
  continueHistory?: JobContinueHistoryEntry[];
}

export interface ContinueJobArgs {
  id: string;
  prompt?: string;
  promptFile?: string;
  extraRounds?: number;
  model?: string;
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
  stageModels?: JobStageModelsInput;
  driver?: string;
  dryRun?: boolean;
  ticketUrl?: string;
  ticketUrls?: string[];
  linearIssue?: string;
  jobType?: JobProfile;
  profile?: JobProfile;
  docsTemplate?: JobInput["docsTemplate"];
  watchdog?: JobInput["watchdog"];
  /** Human label for dashboard rows (derived at create when omitted). */
  title?: string;
  /** See {@link JobInput.expectPr}. */
  expectPr?: boolean;
}

export type JobEvent =
  | { type: "stage"; stage: JobStage; reviewRound: number }
  | { type: "log"; line: string }
  | { type: "pr"; url: string }
  | { type: "done"; stage: JobStage };
