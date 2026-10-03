import { appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  consoleDir,
  ensureRepoGithub,
  findGitRoot,
  getRepoGithubBind,
  parseCiSkipReason,
} from "@prgenie/core";

type HookInput = Record<string, unknown>;

export type HookPermission = "allow" | "ask";

export function isPublish(command: string): boolean {
  return (
    /\bgit(\.exe)?\s+push\b/i.test(command) ||
    /\bgh(\.exe)?\s+pr\s+create\b/i.test(command) ||
    /\bgh(\.exe)?\s+pr\s+merge\b/i.test(command) ||
    /\bgh(\.exe)?\s+repo\s+create\b/i.test(command)
  );
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

function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
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

/** True when beforeMCPExecution targets PR Genie (RAD-164). */
export function isPrgenieMcpContext(input: HookInput): boolean {
  for (const s of serverFieldValues(input)) {
    if (serverFieldIdentifiesPrgenie(s)) return true;
  }

  const command = String(input.command ?? "");
  if (/prgenie|plugin[/\\].*mcp[/\\]server/i.test(command)) return true;

  const url = String(input.url ?? input.mcp_url ?? "");
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

/** Destructive MCP tools that always require confirmation (RAD-164 R2). */
export const PRGENIE_MCP_ALWAYS_ASK_TOOLS = new Set(["delete_local_pr", "delete_learning"]);

/** Gated names; without server/command/url these still run through the PR Genie gate (RAD-164 R4). */
export const PRGENIE_MCP_GATED_TOOL_NAMES = new Set([
  "export_local_pr",
  "record_export_gate_override",
  "gh_use",
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

export type McpGateDecision = "allow" | "ask" | "invalid";

/** Whether a PR Genie MCP tool requires human confirmation before execution. */
export function mcpHumanConfirmationGate(
  toolName: string,
  toolInput: Record<string, unknown> | null,
): McpGateDecision {
  if (!toolName) return "ask";
  switch (toolName) {
    case "export_local_pr":
    case "record_export_gate_override":
    case "gh_use":
      return "ask";
    case "set_status": {
      if (toolInput === null) return "invalid";
      const status = String(toolInput.status ?? "");
      if (status === "approved" || status === "reviewed") return "ask";
      if (toolInput.skipPreflight === true) return "ask";
      const ciSkipReason = toolInput.ciSkipReason;
      if (typeof ciSkipReason === "string" && ciSkipReason.trim()) return "ask";
      const ciSkipChecks = toolInput.ciSkipChecks;
      if (Array.isArray(ciSkipChecks) && ciSkipChecks.some((c) => String(c).trim())) {
        return "ask";
      }
      return "allow";
    }
    case "add_comment": {
      if (toolInput === null) return "invalid";
      const role = toolInput.role;
      if (role === "reviewer") return "allow";
      if (role === "human" || role === undefined) return "ask";
      if (role === "agent") {
        const body = String(toolInput.body ?? "");
        if (parseCiSkipReason(body)) return "ask";
        return "allow";
      }
      return "ask";
    }
    case "delete_local_pr":
    case "delete_learning":
      return "ask";
    default:
      if (PRGENIE_MCP_AGENT_TOOLS.has(toolName)) return "allow";
      return "ask";
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

export async function appendBeforeMcpExecutionLog(cwd: string, input: HookInput): Promise<void> {
  const root = await findGitRoot(cwd);
  if (!root) return;
  const dir = await consoleDir(root);
  const file = path.join(dir, "before-mcp-execution.jsonl");
  const line = JSON.stringify(sanitizeBeforeMcpLogPayload(input));
  await appendFile(file, `${line}\n`, "utf8");
}

export function decideBeforeMcpExecution(input: HookInput): { permission: HookPermission } | null {
  const rawName = rawMcpToolName(input);
  if (!rawName) return null;
  const toolName = normalizeBareMcpToolName(input);
  if (!shouldApplyPrgenieMcpGate(input, toolName)) {
    return { permission: "allow" };
  }
  const parsed = parseToolInput(input.tool_input ?? input.toolInput);
  const gate = mcpHumanConfirmationGate(toolName, parsed);
  if (gate === "invalid") return mcpAskPayload(toolName);
  if (gate === "ask") return mcpAskPayload(toolName);
  return { permission: "allow" };
}

export async function main(): Promise<void> {
  let input: HookInput;
  try {
    const raw = readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  if (rawMcpToolName(input)) {
    appendBeforeMcpExecutionLog(inferCwd(input), input).catch(() => {});
  }

  const mcpDecision = decideBeforeMcpExecution(input);
  if (mcpDecision !== null) {
    process.stdout.write(JSON.stringify(mcpDecision));
    return;
  }

  const command = String(input.command ?? "");
  const cwd = String(input.cwd ?? process.cwd());
  const root = await findGitRoot(cwd);

  if (root && isGithubCli(command)) {
    const bind = await getRepoGithubBind(root);
    const switchingTo = switchUser(command);
    if (bind && switchingTo && switchingTo.toLowerCase() !== bind.login.toLowerCase()) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie: this repo is bound to GitHub account ${bind.login}. ${switchingTo} is a different login.`,
          agent_message: `This repository is bound to ${bind.login}. Do not gh auth switch to ${switchingTo}. Use prgenie gh use ${bind.login} if the bind should change.`,
        }),
      );
      return;
    }
    try {
      await ensureRepoGithub(root);
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie could not switch to the bound GitHub account: ${err instanceof Error ? err.message : err}`,
          agent_message:
            "Could not switch GitHub accounts. Ask the user to run prgenie gh use <login>.",
        }),
      );
      return;
    }
  }

  if (isPublish(command)) {
    const bind = root ? await getRepoGithubBind(root) : null;
    const asWho = bind ? ` as ${bind.login}` : "";
    process.stdout.write(
      JSON.stringify({
        permission: "ask",
        user_message: `PR Genie: this would publish to GitHub${asWho}. Prefer a local PR Genie loop unless you explicitly want to export.`,
        agent_message:
          "Do not git push or gh pr create unless the user explicitly asked to export (/export). Ask whether they want to open a PR Genie local PR (/start, /steward, or /local-pr) — do not create one unless they opt in.",
      }),
    );
    return;
  }

  process.stdout.write(JSON.stringify({ permission: "allow" }));
}
