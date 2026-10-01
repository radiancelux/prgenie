import { readFileSync } from "node:fs";
import { ensureRepoGithub, findGitRoot, getRepoGithubBind } from "@prgenie/core";

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

/** True when beforeMCPExecution targets PR Genie (RAD-164). */
export function isPrgenieMcpContext(input: HookInput): boolean {
  const serverName = String(input.mcp_server_name ?? input.server_name ?? "");
  const command = String(input.command ?? "");
  if (serverName) return /prgenie/i.test(serverName);
  if (/prgenie/i.test(command)) return true;
  return true;
}

export function mcpToolName(input: HookInput): string {
  return String(input.tool_name ?? input.toolName ?? "").trim();
}

export type McpGateDecision = "allow" | "ask" | "invalid";

/** Whether a PR Genie MCP tool requires human confirmation before execution. */
export function mcpHumanConfirmationGate(
  toolName: string,
  toolInput: Record<string, unknown> | null,
): McpGateDecision {
  if (!toolName) return "allow";
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
      if (role === "agent" || role === "reviewer") return "allow";
      return "ask";
    }
    default:
      return "allow";
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

export function decideBeforeMcpExecution(input: HookInput): { permission: HookPermission } | null {
  const toolName = mcpToolName(input);
  if (!toolName) return null;
  if (!isPrgenieMcpContext(input)) {
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
