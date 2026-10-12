import { appendFile, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  consoleDir,
  currentBranch,
  ensureRepoGithub,
  findGitRoot,
  getRepoGithubBind,
  isArchivedPr,
  listLocalPrs,
  parseJsonObject,
} from "@prgenie/core";
import {
  isLoopAgentShellContext,
  isPathInsideOrEqual,
  loopAgentShellDenial,
  pathInLoopWorktree,
  shellCommandPathScan,
  worktreeForGitAdminDir,
  prgenieCliHumanOnlyCommand,
  resolveDefaultBranchForCwd,
  type PrgenieHumanOnlyCli,
  shellCommandPublishes,
  type HookPermission,
} from "./loop-github-gate.js";
import {
  gateEscapeHatchSetDenyPayload,
  gateNoInputPayload,
  hookPrefersAskOverDeny,
  normalizeHookWorkspacePath,
  parseHookPayloadBuffer,
  readHookStdin,
  shellCommandSetsGithubGateAskFlag,
} from "./hook-stdin.js";

/** On-disk spelling of a path (expands Windows 8.3 short names and fixes case) when it exists. */
function canonicalFsPath(p: string): string {
  try {
    return realpathSync.native(path.resolve(p));
  } catch {
    return p;
  }
}

/**
 * Loop ids in `stewards.json`, read without the file lock so the hook never writes state.
 * `"unreadable"` when the file exists but cannot be read or parsed.
 */
export async function stewardBoundLoopIds(root: string): Promise<string[] | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(await consoleDir(root), "stewards.json"), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? [] : "unreadable";
  }
  try {
    const parsed = parseJsonObject<{ bindings?: unknown } | null>(raw);
    const bindings = parsed?.bindings;
    if (bindings === undefined) return [];
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return "unreadable";
    return Object.values(bindings as Record<string, unknown>)
      .map((b) => (b && typeof b === "object" ? (b as { loopId?: unknown }).loopId : null))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return "unreadable";
  }
}

export async function isLoopAgentShellContextForGate(
  input: HookInput,
  cwd: string,
  root: string | null,
): Promise<boolean> {
  if (isLoopAgentShellContext(input, cwd)) return true;
  if (!root || !isPathInsideOrEqual(canonicalFsPath(cwd), canonicalFsPath(root))) return false;
  const boundIds = await stewardBoundLoopIds(root);
  if (boundIds === "unreadable") return true;
  if (boundIds.length === 0) return false;
  const liveIds = new Set(
    (await listLocalPrs(root)).filter((p) => !isArchivedPr(p)).map((p) => p.id),
  );
  return boundIds.some((id) => liveIds.has(id));
}

type HookInput = Record<string, unknown>;

export type { HookPermission };

export function isPublish(command: string): boolean {
  return shellCommandPublishes(command);
}

export function isGithubCli(command: string): boolean {
  return /\bgh(\.exe)?\b/i.test(command) || /\bgit(\.exe)?\s+push\b/i.test(command);
}

export function switchUser(command: string): string | null {
  const match = command.match(/\bgh(?:\.exe)?\s+auth\s+switch\b[\s\S]*?--user\s+(\S+)/i);
  return match?.[1] ?? null;
}

export function parseToolInput(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function inferHookCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) {
    return normalizeHookWorkspacePath(input.cwd);
  }
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return normalizeHookWorkspacePath(roots[0]);
  }
  const toolInput = parseToolInput(input.tool_input ?? input.toolInput);
  if (toolInput && typeof toolInput.cwd === "string" && toolInput.cwd) {
    return normalizeHookWorkspacePath(toolInput.cwd);
  }
  return process.cwd();
}

function serverIdStrings(input: HookInput): string[] {
  const out: string[] = [];
  for (const key of [
    "mcp_server_name",
    "server_name",
    "serverIdentifier",
    "server_identifier",
    "mcp_server_identifier",
  ]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return [...new Set(out)];
}

/** Raw tool name field(s) Cursor may send before normalization (RAD-164). */
export function rawMcpToolName(input: HookInput): string {
  for (const key of ["tool_name", "toolName", "name"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Strip `<server>-`, `mcp_<server>_`, and `<server>:` prefixes (RAD-164 follow-up). */
export function normalizeBareMcpToolName(input: HookInput): string {
  const raw = rawMcpToolName(input);
  if (!raw) return "";
  const serverIds = serverIdStrings(input);
  let name = raw;
  for (const id of serverIds) {
    for (const prefix of [`${id}-`, `${id}:`, `mcp_${id}_`, `mcp-${id}-`]) {
      if (name.startsWith(prefix)) {
        name = name.slice(prefix.length);
        break;
      }
    }
  }
  if (/^plugin-prgenie-prgenie[-:]/i.test(name)) {
    name = name.replace(/^plugin-prgenie-prgenie[-:]/i, "");
  }
  if (/^mcp_plugin-prgenie-prgenie_/i.test(name)) {
    name = name.replace(/^mcp_plugin-prgenie-prgenie_/i, "");
  }
  return name;
}

function serverFieldValues(input: HookInput): string[] {
  const out: string[] = [];
  for (const key of [
    "mcp_server_name",
    "server_name",
    "serverIdentifier",
    "server_identifier",
    "mcp_server_identifier",
    "providerIdentifier",
    "provider_identifier",
  ]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

function serverFieldIdentifiesPrgenie(value: string): boolean {
  if (/prgenie/i.test(value) || /^plugin-prgenie/i.test(value)) return true;
  if (/\bPR\s+Genie\b/i.test(value)) return true;
  return false;
}

/** A payload field as a string; anything else (objects, arrays, numbers) reads as empty. */
function stringField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** True when beforeMCPExecution targets PR Genie (RAD-164). */
export function isPrgenieMcpContext(input: HookInput): boolean {
  for (const s of serverFieldValues(input)) {
    if (serverFieldIdentifiesPrgenie(s)) return true;
  }

  const command = stringField(input.command);
  if (/prgenie|plugin[/\\].*mcp[/\\]server/i.test(command)) return true;

  const url = stringField(input.url) || stringField(input.mcp_url);
  if (/prgenie/i.test(url)) return true;

  const rawName = rawMcpToolName(input);
  if (/^plugin-prgenie-prgenie[-:]/i.test(rawName)) return true;
  if (/^mcp_plugin-prgenie-prgenie_/i.test(rawName)) return true;

  return false;
}

/** @deprecated use rawMcpToolName — kept for tests importing mcpToolName */
export function mcpToolName(input: HookInput): string {
  return normalizeBareMcpToolName(input);
}

/** PR Genie MCP tools agents may call without confirmation (RAD-164 R2 allowlist). */
export const PRGENIE_MCP_AGENT_TOOLS = new Set([
  "list_sessions",
  "learning_digest",
  "list_worktrees",
  "ensure_worktree",
  "list_local_prs",
  "create_local_pr",
  "attach_local_pr",
  "update_local_pr",
  "get_local_pr",
  "address_comment",
  "resolve_comment",
  "edit_comment",
  "delete_comment",
  "complete_review",
  "get_diff",
  "reopen_local_pr",
  "watch_status",
  "watch_stop",
  "watch_start",
  "claim_review",
  "gh_list",
  "gh_status",
  "list_learnings",
  "get_learning",
  "disable_learning",
  "enable_learning",
  "run_preflight",
  "mark_review_interrupted",
  "resume_review",
  "reconcile_session",
  "run_ci",
  "abort_ci",
  "shepherd_status",
  "bind_steward",
  "steward_next",
]);

/**
 * Human-only MCP tools agents always receive `deny` for (RAD-188 CoS; RAD-190 R5/R6 moved the former
 * always-ask tools here because Cursor 3.23 on Windows runs `ask` with no dialog).
 */
export const PRGENIE_MCP_AGENT_DENY_TOOLS = new Set([
  "export_local_pr",
  "record_export_gate_override",
  "gh_use",
  "delete_local_pr",
  "delete_learning",
  "clear_loop_cancel",
]);

/**
 * Gated names; without server/command/url these still run through the PR Genie gate (RAD-164 R4).
 * Derived from the deny list so every agent-denied tool is gated in that payload shape (RAD-190 R6).
 */
export const PRGENIE_MCP_GATED_TOOL_NAMES = new Set([
  ...PRGENIE_MCP_AGENT_DENY_TOOLS,
  "set_status",
  "add_comment",
]);

const MCP_IDENTITY_FIELD_KEYS = [
  "mcp_server_name",
  "server_name",
  "serverIdentifier",
  "server_identifier",
  "mcp_server_identifier",
  "providerIdentifier",
  "provider_identifier",
  "command",
  "url",
  "mcp_url",
] as const;

const MCP_LOG_SERVER_PROVIDER_KEYS = [
  "mcp_server_name",
  "server_name",
  "serverIdentifier",
  "server_identifier",
  "mcp_server_identifier",
  "providerIdentifier",
  "provider_identifier",
] as const;

export function hasMcpIdentityFields(input: HookInput): boolean {
  for (const key of MCP_IDENTITY_FIELD_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return true;
  }
  return false;
}

/** True when beforeMCPExecution should apply PR Genie MCP gating (RAD-164). */
export function shouldApplyPrgenieMcpGate(input: HookInput, toolName: string): boolean {
  if (isPrgenieMcpContext(input)) return true;
  if (!hasMcpIdentityFields(input) && PRGENIE_MCP_GATED_TOOL_NAMES.has(toolName)) return true;
  return false;
}

/**
 * Gate decision for a PR Genie MCP tool. There is no `ask`: Cursor 3.23 on Windows runs `ask` with no
 * dialog, so every former ask is a deliberate allow or a deny (RAD-190 R5, table in
 * docs/github-access.md). Only the human-set `PRGENIE_GITHUB_GATE_ASK` turns a deny back into ask.
 */
export type McpGateDecision = "allow" | "deny" | "invalid";

/** Whether an agent may run a PR Genie MCP tool. */
export function mcpHumanConfirmationGate(
  toolName: string,
  toolInput: Record<string, unknown> | null,
): McpGateDecision {
  if (!toolName) return "deny";
  if (PRGENIE_MCP_AGENT_DENY_TOOLS.has(toolName)) return "deny";
  switch (toolName) {
    case "set_status": {
      if (toolInput === null) return "invalid";
      const rawStatus = toolInput.status ?? "";
      // A non-string status (for example {"toString":null}) is malformed: fail closed (RAD-190 R5).
      if (typeof rawStatus !== "string") return "invalid";
      const status = rawStatus.trim().toLowerCase();
      // Human sign-off (approved) and review clear (reviewed, via complete_review) are not agent writes.
      if (status === "approved" || status === "reviewed") return "deny";
      // CI skips (skipPreflight, ciSkipReason, ciSkipChecks) are a deliberate allow: the skip is
      // recorded on the packet, the export gate and export body name it, and export stays human-only.
      return "allow";
    }
    case "add_comment": {
      if (toolInput === null) return "invalid";
      const role = toolInput.role;
      // A non-string body (an object would be stored as "[object Object]") is malformed: deny.
      if (toolInput.body !== undefined && typeof toolInput.body !== "string") return "invalid";
      // role=agent (including a `CI skipped:` comment, same reason as set_status) and role=reviewer.
      if (role === "reviewer" || role === "agent") return "allow";
      // role=human, or omitted (defaults to human): an agent must not file findings as the human.
      return "deny";
    }
    default:
      if (PRGENIE_MCP_AGENT_TOOLS.has(toolName)) return "allow";
      return "deny";
  }
}

export function mcpAskPayload(toolName: string): {
  permission: "ask";
  user_message: string;
  agent_message: string;
} {
  return {
    permission: "ask",
    user_message: `PR Genie: an agent wants to run MCP tool "${toolName}", which needs your confirmation.`,
    agent_message: `Human-only MCP action (${toolName}). Do not retry without the user approving this call in Cursor.`,
  };
}

/** Where the human does this instead (user_message suffix) for each denied MCP tool. */
function mcpHumanPath(toolName: string, toolInput: Record<string, unknown> | null): string {
  switch (toolName) {
    case "export_local_pr":
      return "Use **Open on GitHub** in the Local PRs panel or run `prgenie export <id>` yourself.";
    case "record_export_gate_override":
      return "Record an override yourself with `prgenie export-gate-override <id> --who … --why …`, then use **Open on GitHub** or `prgenie export <id>`.";
    case "gh_use":
      return "Run `prgenie gh use <login>` yourself. Export with **Open on GitHub** in the Local PRs panel or `prgenie export <id>`.";
    case "clear_loop_cancel":
      return "Clear a cancel yourself with **Resume loop** in the Local PRs panel.";
    case "delete_local_pr":
      return "Delete the loop yourself from the Local PRs panel or with `prgenie delete <id>`.";
    case "delete_learning":
      return "Delete the learning yourself with `prgenie delete-learning <id>`.";
    case "set_status":
      return stringField(toolInput?.status).trim().toLowerCase() === "approved"
        ? "Sign off yourself with **Open on GitHub** / `prgenie approve <id>`."
        : "Reviewers clear a review with `complete_review`; set the status yourself with `prgenie status <id> <status>`.";
    case "add_comment":
      return "Agents comment with role=agent or role=reviewer; file human findings yourself in the panel or with `prgenie comment`.";
    default:
      return "Run it yourself from the Local PRs panel or the `prgenie` CLI if you want it.";
  }
}

export function mcpAgentDenyPayload(
  toolName: string,
  toolInput: Record<string, unknown> | null = null,
): {
  permission: "deny";
  user_message: string;
  agent_message: string;
} {
  const label = toolName || "(unnamed tool)";
  return {
    permission: "deny",
    user_message: `PR Genie: agents cannot run "${label}". ${mcpHumanPath(toolName, toolInput)}`,
    agent_message: `Human-only MCP action (${label}). Do not retry this call or work around the block. Stop and tell the user to do it from the panel or CLI.`,
  };
}

/** How the CLI subcommand reads in messages. */
function prgenieCliLabel(sub: PrgenieHumanOnlyCli): string {
  if (sub === "run-time") return "a `prgenie` subcommand decided at run time";
  if (sub === "too-complex") return "a command too large or nested for the gate to check";
  return `\`prgenie ${sub}\``;
}

/** The CLI action as named in agent messages. */
function prgenieCliAction(sub: PrgenieHumanOnlyCli): string {
  if (sub === "run-time") return "prgenie <run-time subcommand>";
  if (sub === "too-complex") return "a command too complex to check for prgenie export";
  return `prgenie ${sub}`;
}

/** What the human runs instead, per human-only CLI subcommand. */
function prgenieCliHumanPath(sub: PrgenieHumanOnlyCli): string {
  switch (sub) {
    case "gh use":
      return "Run `prgenie gh use <login>` yourself in your own terminal. Export with **Open on GitHub** in the Local PRs panel or `prgenie export <id>`.";
    case "export-gate-override":
      return "Run `prgenie export-gate-override <id> --who … --why …` yourself in your own terminal, then use **Open on GitHub** or `prgenie export <id>`.";
    default:
      return "Use **Open on GitHub** in the Local PRs panel or run `prgenie export <id>` yourself.";
  }
}

/** Retry guidance when the CLI check ran out of its work budget (not a human-only action). */
const TOO_COMPLEX_RETRY =
  "Retry it in smaller pieces: put a long message or script in a file (`git commit -F msg.txt` instead of a huge `-m`, `pwsh -File x.ps1` instead of a huge `-Command`), or split it into several shorter commands. Splitting it does not permit human-only PR Genie actions (such as `prgenie export`); those stay blocked.";

/** Too-complex text for the human (RAD-190 R6 nit 2). */
const TOO_COMPLEX_USER =
  "The agent can rerun it as smaller commands or with long text moved into a file. Human-only PR Genie actions (such as `prgenie export`) stay blocked either way.";

/** Human-only prgenie CLI subcommands from an agent shell (RAD-190 R1), same guidance as RAD-188. */
export function shellPrgenieCliDenyPayload(sub: PrgenieHumanOnlyCli): {
  permission: "deny";
  user_message: string;
  agent_message: string;
} {
  if (sub === "too-complex") {
    return {
      permission: "deny",
      user_message: `PR Genie: an agent shell command was too large or nested for the GitHub gate to check, so it was blocked. ${TOO_COMPLEX_USER}`,
      agent_message: `This command is too large or nested for the PR Genie gate to check, so it was blocked. ${TOO_COMPLEX_RETRY}`,
    };
  }
  const runTime =
    sub === "run-time"
      ? " The subcommand comes from a variable or substitution, so the gate cannot tell it is not export; spell read-only subcommands literally."
      : "";
  return {
    permission: "deny",
    user_message: `PR Genie: agents cannot run ${prgenieCliLabel(sub)} from the shell. ${prgenieCliHumanPath(sub)}`,
    agent_message: `Human-only CLI action (${prgenieCliAction(sub)}). Do not retry it through another wrapper (pnpm, npx, node, cmd /c, pwsh -c) or work around this block.${runTime} Stop and tell the user to do it from the panel or CLI.`,
  };
}

export function shellPrgenieCliAskPayload(sub: PrgenieHumanOnlyCli): {
  permission: "ask";
  user_message: string;
  agent_message: string;
} {
  if (sub === "too-complex") {
    return {
      permission: "ask",
      user_message: `PR Genie: an agent shell command is too large or nested for the GitHub gate to check. ${TOO_COMPLEX_USER}`,
      agent_message: `This command is too large or nested for the PR Genie gate to check. Do not retry it unchanged without the user approving it in Cursor. ${TOO_COMPLEX_RETRY}`,
    };
  }
  return {
    permission: "ask",
    user_message: `PR Genie: an agent wants to run ${prgenieCliLabel(sub)}, which is a human-only action.`,
    agent_message: `Human-only CLI action (${prgenieCliAction(sub)}). Do not retry without the user approving this call in Cursor.`,
  };
}

export function shellPublishDenyPayload(asWho = ""): {
  permission: "deny";
  user_message: string;
  agent_message: string;
} {
  const who = asWho ? ` as ${asWho}` : "";
  return {
    permission: "deny",
    user_message: `PR Genie: agents cannot publish to GitHub${who} from the shell. Use **Open on GitHub** in the Local PRs panel or run \`prgenie export <id>\` yourself.`,
    agent_message:
      "Publishing is human-only. Do not retry git push or gh pr create/merge, and do not work around this block. Stop and tell the user to export from the panel or CLI.",
  };
}

export function shellPublishAskPayload(asWho = ""): {
  permission: "ask";
  user_message: string;
  agent_message: string;
} {
  const who = asWho ? ` as ${asWho}` : "";
  return {
    permission: "ask",
    user_message: `PR Genie: this would publish to GitHub${who}. Prefer a local PR Genie loop unless you explicitly want to export.`,
    agent_message:
      "Do not git push or gh pr create unless the user explicitly asked to export (/export). Ask whether they want to open a PR Genie local PR (/start, /steward, or /local-pr) — do not create one unless they opt in.",
  };
}

type GatePayload = { permission: HookPermission; user_message: string; agent_message: string };

/** Bound-account shell guards (RAD-190 R5: former asks, now deny unless the human set the flag). */
export function shellAccountSwitchPayload(boundLogin: string, switchingTo: string): GatePayload {
  return {
    permission: hookPrefersAskOverDeny() ? "ask" : "deny",
    user_message: `PR Genie: this repo is bound to GitHub account ${boundLogin}. ${switchingTo} is a different login. Run \`prgenie gh use <login>\` yourself if the bind should change.`,
    agent_message: `This repository is bound to ${boundLogin}. Do not gh auth switch to ${switchingTo} or work around this block. Stop and ask the user to run prgenie gh use <login> if the bind should change.`,
  };
}

export function shellBindSwitchFailedPayload(err: unknown): GatePayload {
  return {
    permission: hookPrefersAskOverDeny() ? "ask" : "deny",
    user_message: `PR Genie could not switch to the bound GitHub account: ${err instanceof Error ? err.message : err}. Fix it yourself with \`prgenie gh use <login>\`.`,
    agent_message:
      "Could not switch to the bound GitHub account, so this gh / git push command is blocked. Do not retry or switch accounts yourself. Stop and ask the user to run prgenie gh use <login>.",
  };
}

export function sanitizeBeforeMcpLogPayload(input: HookInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    topLevelKeys: Object.keys(input),
    rawToolName: rawMcpToolName(input),
    normalizedToolName: normalizeBareMcpToolName(input),
  };
  for (const key of MCP_LOG_SERVER_PROVIDER_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

export async function appendBeforeMcpExecutionLog(
  cwd: string,
  input: HookInput,
  meta?: { stdinByteCount?: number; stdinReadError?: string | null },
): Promise<void> {
  const root = await findGitRoot(cwd);
  if (!root) return;
  const dir = await consoleDir(root);
  const file = path.join(dir, "before-mcp-execution.jsonl");
  const line = JSON.stringify({
    at: new Date().toISOString(),
    stdinByteCount: meta?.stdinByteCount ?? null,
    stdinReadError: meta?.stdinReadError ?? null,
    ...sanitizeBeforeMcpLogPayload(input),
  });
  await appendFile(file, `${line}\n`, "utf8");
}

export function decideBeforeMcpExecution(input: HookInput): { permission: HookPermission } | null {
  const rawName = rawMcpToolName(input);
  if (!rawName) {
    // A PR Genie MCP payload with no tool name is malformed: fail closed (RAD-190 R5).
    if (
      serverFieldValues(input).some(serverFieldIdentifiesPrgenie) &&
      !stringField(input.command)
    ) {
      return hookPrefersAskOverDeny() ? mcpAskPayload("") : mcpAgentDenyPayload("");
    }
    return null;
  }
  const toolName = normalizeBareMcpToolName(input);
  if (!shouldApplyPrgenieMcpGate(input, toolName)) {
    return { permission: "allow" };
  }
  const parsed = parseToolInput(input.tool_input ?? input.toolInput);
  const gate = mcpHumanConfirmationGate(toolName, parsed);
  if (gate === "allow") return { permission: "allow" };
  // "deny" and "invalid" (unparseable tool_input) both fail closed (RAD-190 R5).
  return hookPrefersAskOverDeny() ? mcpAskPayload(toolName) : mcpAgentDenyPayload(toolName, parsed);
}

/**
 * Nearest ancestor of `p` (or `p`) holding a `.git` entry, without spawning git. `memo` (dir →
 * answer) is shared across one command's targets, so a deep chain of targets is walked once.
 */
function nearestGitRoot(p: string, memo: Map<string, string | null> = new Map()): string | null {
  const walked: string[] = [];
  let cur = path.resolve(p);
  let found: string | null = null;
  for (let i = 0; i < 4096; i++) {
    const known = memo.get(cur);
    if (known !== undefined) {
      found = known;
      break;
    }
    walked.push(cur);
    if (existsSync(path.join(cur, ".git"))) {
      found = cur;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of walked) memo.set(d, found);
  return found;
}

/**
 * RAD-190 loop-only scope: true when the hook cwd itself is a PR Genie loop agent's — the RAD-163
 * context ({@link isLoopAgentShellContextForGate}) or a cwd / git root inside a loop worktree.
 */
export async function cwdIsLoopContext(
  input: HookInput,
  cwd: string,
  root: string | null,
): Promise<boolean> {
  if (await isLoopAgentShellContextForGate(input, cwd, root)) return true;
  for (const p of [cwd, root]) {
    if (p !== null && (pathInLoopWorktree(p) || pathInLoopWorktree(canonicalFsPath(p))))
      return true;
  }
  return false;
}

export type LoopTarget = { cwd: string; runTime: false } | { cwd: string; runTime: true } | null;

/**
 * RAD-190 loop-only scope: for a command from a non-loop cwd that would be denied in a loop
 * (publish or a RAD-163 deny), the loop directory it acts in, found from its `cd` / `git -C` /
 * `--git-dir` / `GIT_DIR` / `env -C` / `-WorkingDirectory` targets ({@link shellCommandPathTargets}),
 * or `runTime` when a target is decided at run time or the scan hits its bounds (fail closed).
 * Null for a normal agent's command.
 */
export async function loopTargetOfCommand(
  input: HookInput,
  command: string,
  cwd: string,
): Promise<LoopTarget> {
  const scan = shellCommandPathScan(command, cwd);
  // No directory target at all: the command runs in the (non-loop) cwd.
  if (scan.targets.length === 0 && !scan.unresolved) return null;
  if (!isPublish(command) && loopAgentShellDenial(command, "main", null) === null) return null;
  const roots = new Set<string>();
  const memo = new Map<string, string | null>();
  if (scan.unresolved && scan.overBound) {
    // Past a scan bound the answer is a fail-closed deny either way: check the targets as written
    // only, without the filesystem work per target.
    const hit = scan.targets.find((t) => pathInLoopWorktree(t));
    return hit ? { cwd: hit, runTime: false } : { cwd, runTime: true };
  }
  for (const t0 of scan.targets) {
    const lexical = worktreeForGitAdminDir(t0) ?? t0;
    // A symlink or junction to a loop (or its `.loops` folder) counts too: check the real path.
    const real = canonicalFsPath(lexical);
    const realAdmin = worktreeForGitAdminDir(real);
    for (const t of new Set([lexical, real, ...(realAdmin ? [realAdmin] : [])])) {
      if (pathInLoopWorktree(t)) return { cwd: t, runTime: false };
      const tRoot = nearestGitRoot(t, memo);
      if (!tRoot || roots.has(tRoot)) continue;
      roots.add(tRoot);
      if (pathInLoopWorktree(tRoot)) return { cwd: t, runTime: false };
      if (await isLoopAgentShellContextForGate(input, tRoot, tRoot)) {
        return { cwd: tRoot, runTime: false };
      }
    }
  }
  if (scan.unresolved) return { cwd, runTime: true };
  return null;
}

/** A normal agent's publish whose target directory is decided at run time (RAD-190). */
export function shellRunTimeTargetPayload(ask: boolean): {
  permission: "deny" | "ask";
  user_message: string;
  agent_message: string;
} {
  const why =
    "the directory it runs in (`cd`, `git -C`, `--git-dir`, `GIT_DIR`, a working directory) is decided at run time, so the PR Genie gate cannot tell it is not a PR Genie loop worktree";
  return {
    permission: ask ? "ask" : "deny",
    user_message: `PR Genie: an agent publish command was blocked because ${why}.`,
    agent_message: `Blocked: ${why}. Spell the directory out literally (for example \`git -C /path/to/repo push\` instead of \`git -C "$PWD" push\`). In a loop, \`cd\` in a subshell (\`for d in …; do (cd $d && …); done\`), or \`cd -\` / \`popd\` straight after, and list a glob (\`packages/*\`) instead of \`$(ls …)\`. Then retry. This is not a human-only block; publishing from a PR Genie loop is human-only.`,
  };
}

export async function main(): Promise<void> {
  const { raw, readError } = await readHookStdin();
  const parsed = parseHookPayloadBuffer(raw);
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify(gateNoInputPayload(parsed.reason)));
    return;
  }
  const input = parsed.input;

  if (rawMcpToolName(input)) {
    appendBeforeMcpExecutionLog(inferHookCwd(input), input, {
      stdinByteCount: raw.length,
      stdinReadError: readError,
    }).catch(() => {});
  }

  const mcpDecision = decideBeforeMcpExecution(input);
  if (mcpDecision !== null) {
    process.stdout.write(JSON.stringify(mcpDecision));
    return;
  }

  if (input.command !== undefined && input.command !== null && typeof input.command !== "string") {
    process.stdout.write(
      JSON.stringify(gateNoInputPayload("PR Genie gate received a malformed shell command")),
    );
    return;
  }
  const command = stringField(input.command);
  const cwd = inferHookCwd(input);
  let root: string | null = null;
  try {
    root = await findGitRoot(cwd);
  } catch {
    /* invalid cwd — treat as outside a git repo */
  }

  const cwdInLoop = command ? await cwdIsLoopContext(input, cwd, root) : false;
  if (command && cwdInLoop) {
    const defaultBranch = root ? await resolveDefaultBranchForCwd(cwd, root) : "main";
    const branch = await currentBranch(cwd).catch(() => null);
    const denial = loopAgentShellDenial(command, defaultBranch, branch);
    if (denial) {
      process.stdout.write(JSON.stringify(denial));
      return;
    }
  }

  // Global denies (every agent, loop or not) run before the loop-target scan.
  if (command && shellCommandSetsGithubGateAskFlag(command)) {
    process.stdout.write(JSON.stringify(gateEscapeHatchSetDenyPayload()));
    return;
  }

  const cliSub = command ? prgenieCliHumanOnlyCommand(command) : null;
  if (cliSub) {
    process.stdout.write(
      JSON.stringify(
        hookPrefersAskOverDeny()
          ? shellPrgenieCliAskPayload(cliSub)
          : shellPrgenieCliDenyPayload(cliSub),
      ),
    );
    return;
  }

  // RAD-190 loop-only scope: a command from a non-loop cwd that cds into or points git at a loop
  // is still a loop agent's.
  let loopCwd: string | null = cwdInLoop ? cwd : null;
  if (command && !cwdInLoop) {
    const target = await loopTargetOfCommand(input, command, cwd);
    if (target?.runTime) {
      process.stdout.write(JSON.stringify(shellRunTimeTargetPayload(hookPrefersAskOverDeny())));
      return;
    }
    if (target) {
      loopCwd = target.cwd;
      const loopRoot = nearestGitRoot(loopCwd);
      const defaultBranch = loopRoot
        ? await resolveDefaultBranchForCwd(loopCwd, loopRoot).catch(() => "main")
        : "main";
      const branch = await currentBranch(loopCwd).catch(() => null);
      const denial = loopAgentShellDenial(command, defaultBranch, branch);
      if (denial) {
        process.stdout.write(JSON.stringify(denial));
        return;
      }
    }
  }

  // RAD-190 loop-only scope: git push / gh publish denies apply only to PR Genie loop agents. A
  // normal agent publishes with its own (fine-grained) token; the PR Genie CLI / MCP denies stay global.
  if (command && loopCwd && isPublish(command)) {
    const bind = root ? await getRepoGithubBind(root) : null;
    const asWho = bind ? bind.login : "";
    process.stdout.write(
      JSON.stringify(
        hookPrefersAskOverDeny() ? shellPublishAskPayload(asWho) : shellPublishDenyPayload(asWho),
      ),
    );
    return;
  }

  if (root && isGithubCli(command)) {
    const bind = await getRepoGithubBind(root);
    const switchingTo = switchUser(command);
    if (bind && switchingTo && switchingTo.toLowerCase() !== bind.login.toLowerCase()) {
      process.stdout.write(JSON.stringify(shellAccountSwitchPayload(bind.login, switchingTo)));
      return;
    }
    try {
      await ensureRepoGithub(root);
    } catch (err) {
      process.stdout.write(JSON.stringify(shellBindSwitchFailedPayload(err)));
      return;
    }
  }

  process.stdout.write(JSON.stringify({ permission: "allow" }));
}
