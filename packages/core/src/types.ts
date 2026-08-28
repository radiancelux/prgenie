export type LocalPrStatus = "draft" | "ready" | "approved" | "changes_requested";

export type CommentRole = "human" | "agent" | "reviewer";

export interface LocalPrComment {
  id: string;
  body: string;
  createdAt: string;
  author: string;
  role: CommentRole;
  path?: string;
  line?: number;
  side?: "left" | "right";
  replyTo?: string;
  resolvedAt?: string;
  resolvedBy?: string;
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
  /** HEAD sha we last asked a reviewer Task to look at. Blocks repeat review until HEAD moves. */
  reviewRequestedSha: string | null;
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
  "approved",
  "changes_requested",
];

export const COMMENT_ROLES: CommentRole[] = ["human", "agent", "reviewer"];
