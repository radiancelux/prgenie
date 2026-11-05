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
  lastVerdict: "APPROVE" | "CHANGES" | null;
  error: string | null;
  logPath: string;
  steerQueue: string[];
  stopRequested: boolean;
  dryRun: boolean;
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
}

export type JobEvent =
  | { type: "stage"; stage: JobStage; reviewRound: number }
  | { type: "log"; line: string }
  | { type: "pr"; url: string }
  | { type: "done"; stage: JobStage };
