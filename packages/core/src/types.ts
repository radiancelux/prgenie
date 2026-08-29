export type LocalPrStatus =
  | "draft"
  | "ready"
  | "changes_requested"
  | "reviewed"
  | "approved";

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
  "changes_requested",
  "reviewed",
  "approved",
];

export const COMMENT_ROLES: CommentRole[] = ["human", "agent", "reviewer"];

export const COMMENT_STATUSES: CommentStatus[] = ["open", "addressed", "resolved"];
