import { detectDefaultBase, localBaseRef, loopWorktreeIdentity } from "@prgenie/core";

type HookInput = Record<string, unknown>;

export type HookPermission = "allow" | "ask" | "deny";

export const PRGENIE_LOOP_SUBAGENT_TYPES = new Set([
  "prgenie-implementor",
  "prgenie-implementor-strong",
  "prgenie-reviewer",
]);

/** True when a PR Genie loop agent (implementor, reviewer, or steward skill) runs a shell command. */
export function isLoopAgentShellContext(input: HookInput, cwd: string): boolean {
  const sub = String(input.subagent_type ?? "").trim();
  if (PRGENIE_LOOP_SUBAGENT_TYPES.has(sub)) return true;
  if (loopWorktreeIdentity(cwd)) return true;
  const skill = String(input.skill ?? input.skill_name ?? input.active_skill ?? "").trim();
  if (/^steward$/i.test(skill)) return true;
  const skills = input.active_skills;
  if (Array.isArray(skills) && skills.some((s) => String(s).trim().toLowerCase() === "steward")) {
    return true;
  }
  return false;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function ghSubcommandTokens(tokens: string[]): string[] {
  const ghIdx = tokens.findIndex(
    (t) => t.toLowerCase() === "gh" || t.toLowerCase().endsWith("gh.exe"),
  );
  if (ghIdx < 0) return [];
  return tokens.slice(ghIdx + 1);
}

function ghApiMethod(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-X" || t === "--method") {
      const next = tokens[i + 1];
      if (next) return next.toUpperCase();
    }
    if (/^--method=/.test(t)) return t.slice("--method=".length).toUpperCase();
  }
  const methodIdx = tokens.findIndex((t) => /^(POST|PATCH|PUT|DELETE)$/i.test(t));
  if (methodIdx > 0 && tokens[methodIdx - 1]?.toLowerCase() === "api") {
    return tokens[methodIdx].toUpperCase();
  }
  return null;
}

function ghApiEndpointPath(tokens: string[]): string | null {
  const apiIdx = tokens.findIndex((t) => t.toLowerCase() === "api");
  if (apiIdx < 0) return null;
  for (let i = apiIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) continue;
    if (/^(POST|PATCH|PUT|DELETE|GET)$/i.test(t)) continue;
    let path = t;
    if (/^https?:\/\//i.test(path)) {
      path = path.replace(/^https:\/\/api\.github\.com\/?/i, "");
    }
    return path.replace(/^\//, "").split("?")[0] ?? null;
  }
  return null;
}

/** True when gh api would mutate repo lifecycle endpoints (RAD-163 R1). */
export function ghApiRepoLifecycleMutation(command: string): boolean {
  if (!/\bgh(\.exe)?\s+api\b/i.test(command)) return false;
  const tokens = tokenizeCommand(command);
  const sub = ghSubcommandTokens(tokens);
  if (sub[0]?.toLowerCase() !== "api") return false;
  const method = ghApiMethod(sub) ?? "GET";
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) return false;
  const endpoint = ghApiEndpointPath(sub);
  if (!endpoint) return false;
  if (/^user\/repos\/?$/i.test(endpoint)) return true;
  if (/^orgs\/[^/]+\/repos\/?$/i.test(endpoint)) return true;
  if (/^repos\/[^/]+\/[^/]+\/?$/i.test(endpoint)) return true;
  return false;
}

const GH_REPO_ADMIN_SUBCOMMANDS = new Set(["create", "delete", "edit", "rename", "archive"]);

/** Short reason string when a loop agent must not run this shell command; null if allowed. */
export function loopAgentShellDenialReason(command: string): string | null {
  const tokens = tokenizeCommand(command);
  const ghParts = ghSubcommandTokens(tokens);
  if (
    ghParts[0]?.toLowerCase() === "repo" &&
    GH_REPO_ADMIN_SUBCOMMANDS.has(ghParts[1]?.toLowerCase() ?? "")
  ) {
    return `gh repo ${ghParts[1]} is not allowed from loop agents`;
  }
  if (ghParts[0]?.toLowerCase() === "auth") {
    const sub = ghParts[1]?.toLowerCase() ?? "";
    if (sub && sub !== "status") {
      return "gh auth changes are not allowed from loop agents (except gh auth status)";
    }
  }
  for (const blocked of ["ssh-key", "gpg-key", "secret", "variable"] as const) {
    if (ghParts[0]?.toLowerCase() === blocked) {
      return `gh ${blocked} is not allowed from loop agents`;
    }
  }
  if (ghApiRepoLifecycleMutation(command)) {
    return "gh api repo create/delete/admin mutations are not allowed from loop agents";
  }
  return null;
}

export function isForceGitPush(command: string): boolean {
  if (!/\bgit(\.exe)?\s+push\b/i.test(command)) return false;
  if (/\b--force-with-lease\b/i.test(command)) return true;
  if (/(?:^|\s)(?:-f\b|--force\b)(?:\s|$)/i.test(command)) return true;
  if (/\s\+[^\s]+/.test(command)) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a force-push targets the repository default branch (RAD-163 R2). */
export function forcePushTargetsDefaultBranch(command: string, defaultBranch: string): boolean {
  if (!isForceGitPush(command)) return false;
  const local = localBaseRef(defaultBranch);
  const refRe = new RegExp(`\\b(?:refs/heads/)?${escapeRegExp(local)}\\b`, "i");
  if (refRe.test(command)) return true;
  if (/\bHEAD:refs\/heads\//i.test(command) && refRe.test(command)) return true;
  return false;
}

export function loopAgentForcePushDenialReason(
  command: string,
  defaultBranch: string,
): string | null {
  if (!forcePushTargetsDefaultBranch(command, defaultBranch)) return null;
  return `force-push to default branch (${localBaseRef(defaultBranch)}) is not allowed from loop agents`;
}

export function loopAgentShellDenial(
  command: string,
  defaultBranch: string,
): { permission: "deny"; user_message: string; agent_message: string } | null {
  const reason =
    loopAgentShellDenialReason(command) ?? loopAgentForcePushDenialReason(command, defaultBranch);
  if (!reason) return null;
  return {
    permission: "deny",
    user_message: `PR Genie: blocked for loop agents — ${reason}.`,
    agent_message: `${reason}. Loop agents must not create or administer GitHub repos. See docs/github-access.md.`,
  };
}

export async function resolveDefaultBranchForCwd(cwd: string, root: string): Promise<string> {
  try {
    return localBaseRef(await detectDefaultBase(root));
  } catch {
    return localBaseRef(await detectDefaultBase(cwd));
  }
}
