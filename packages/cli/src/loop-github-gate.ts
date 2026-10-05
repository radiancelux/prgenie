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

/** Split compound shell commands; segments are trimmed but may be empty. */
export function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
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
    if (ch === "\n" || ch === "\r") {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      continue;
    }
    if (
      (ch === "&" && command[i + 1] === "&") ||
      (ch === "|" && command[i + 1] === "|") ||
      ch === ";" ||
      ch === "|" ||
      ch === "&"
    ) {
      if (ch === "&" && command[i + 1] === "&") i++;
      if (ch === "|" && command[i + 1] === "|") i++;
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments.length > 0 ? segments : [command.trim()];
}

function ghSubcommandTokens(tokens: string[]): string[] {
  const ghIdx = tokens.findIndex(
    (t) => t.toLowerCase() === "gh" || t.toLowerCase().endsWith("gh.exe"),
  );
  if (ghIdx < 0) return [];
  return tokens.slice(ghIdx + 1);
}

const GH_API_VALUE_FLAGS = new Set([
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
  "-X",
  "--method",
]);

function ghApiInferredMethod(sub: string[]): string {
  let explicit: string | null = null;
  let hasBodyFlags = false;
  for (let i = 0; i < sub.length; i++) {
    const t = sub[i];
    if (t === "-X" || t === "--method") {
      explicit = sub[i + 1]?.toUpperCase() ?? null;
      i++;
      continue;
    }
    const attached = t.match(/^-X(GET|POST|PATCH|PUT|DELETE)$/i);
    if (attached) {
      explicit = attached[1].toUpperCase();
      continue;
    }
    if (/^--method=/i.test(t)) {
      explicit = t.slice("--method=".length).toUpperCase();
      continue;
    }
    if (/^-(f|F)=/.test(t) || /^--field=/.test(t) || /^--raw-field=/.test(t)) {
      hasBodyFlags = true;
      continue;
    }
    if (t === "-f" || t === "-F" || t === "--field" || t === "--raw-field" || t === "--input") {
      hasBodyFlags = true;
      continue;
    }
  }
  if (explicit) return explicit;
  if (hasBodyFlags) return "POST";
  return "GET";
}

function ghApiEndpointPath(sub: string[]): string | null {
  if (sub[0]?.toLowerCase() !== "api") return null;
  for (let i = 1; i < sub.length; i++) {
    const t = sub[i];
    if (GH_API_VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    if (/^(POST|PATCH|PUT|DELETE|GET)$/i.test(t)) continue;
    let pathPart = t;
    if (/^https?:\/\//i.test(pathPart)) {
      pathPart = pathPart.replace(/^https:\/\/api\.github\.com\/?/i, "");
    }
    const normalized = pathPart.replace(/^\//, "").split("?")[0] ?? "";
    if (!normalized || /^Accept:/i.test(normalized) || /\s/.test(normalized)) {
      continue;
    }
    if (normalized.includes(".") && !normalized.startsWith("repos/")) {
      continue;
    }
    return normalized;
  }
  return null;
}

const GRAPHQL_REPO_LIFECYCLE = [
  "createRepository",
  "deleteRepository",
  "updateRepository",
  "archiveRepository",
  "cloneTemplateRepository",
] as const;

function ghGraphqlRepoLifecycleMutation(sub: string[]): boolean {
  if (sub[0]?.toLowerCase() !== "graphql") return false;
  const blob = sub.slice(1).join(" ");
  return GRAPHQL_REPO_LIFECYCLE.some((name) => blob.includes(name));
}

function ghApiRepoLifecycleMutationSingle(command: string): boolean {
  if (!/\bgh(\.exe)?\s+api\b/i.test(command)) return false;
  const tokens = tokenizeCommand(command);
  const sub = ghSubcommandTokens(tokens);
  if (sub[0]?.toLowerCase() !== "api") return false;
  if (sub[1]?.toLowerCase() === "graphql") {
    return ghGraphqlRepoLifecycleMutation(sub.slice(1));
  }
  const apiArgs = sub.slice(1);
  const method = ghApiInferredMethod(apiArgs);
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) return false;
  const endpoint = ghApiEndpointPath(sub);
  if (!endpoint) return false;
  if (/^user\/repos\/?$/i.test(endpoint)) return true;
  if (/^orgs\/[^/]+\/repos\/?$/i.test(endpoint)) return true;
  if (/^repos\/[^/]+\/[^/]+\/?$/i.test(endpoint)) return true;
  return false;
}

/** True when gh api would mutate repo lifecycle endpoints (RAD-163 R1). */
export function ghApiRepoLifecycleMutation(command: string): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    if (ghApiRepoLifecycleMutationSingle(segment)) return true;
  }
  return false;
}

const GH_REPO_ADMIN_SUBCOMMANDS = new Set(["create", "delete", "edit", "rename", "archive"]);

function loopAgentShellDenialReasonSingleSegment(command: string): string | null {
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
  if (ghApiRepoLifecycleMutationSingle(command)) {
    return "gh api repo create/delete/admin mutations are not allowed from loop agents";
  }
  return null;
}

/** Short reason string when a loop agent must not run this shell command; null if allowed. */
export function loopAgentShellDenialReason(command: string): string | null {
  for (const segment of splitShellCommandSegments(command)) {
    const reason = loopAgentShellDenialReasonSingleSegment(segment);
    if (reason) return reason;
  }
  return null;
}

export function isForceGitPush(command: string): boolean {
  if (!/\bgit(\.exe)?\s+push\b/i.test(command)) return false;
  if (/(?:^|\s)--force-with-lease(?:=\S*)?(?=\s|$)/i.test(command)) return true;
  if (/(?:^|\s)--force-if-includes(?:=\S*)?(?=\s|$)/i.test(command)) return true;
  if (/(?:^|\s)(?:-f\b|--force(?:\s|$|=))/i.test(command)) return true;
  if (/\bgit(\.exe)?\s+push\s+(?:[^\s]+\s+)*-[a-zA-Z]*f[a-zA-Z]*/i.test(command)) return true;
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
  const esc = escapeRegExp(local);
  if (new RegExp(`\\+[^\\s]*${esc}(?:\\s|$)`, "i").test(command)) return true;
  if (new RegExp(`HEAD:refs/heads/${esc}\\b`, "i").test(command)) return true;
  if (new RegExp(`HEAD:${esc}\\b`, "i").test(command)) return true;
  if (new RegExp(`refs/heads/${esc}\\b`, "i").test(command)) return true;
  if (new RegExp(`(?:^|\\s)${esc}(?:\\s|$)`, "i").test(command)) return true;
  if (new RegExp(`--force-with-lease=${esc}(?:\\s|$)`, "i").test(command)) return true;
  return false;
}

function loopAgentForcePushDenialReasonSingle(
  command: string,
  defaultBranch: string,
): string | null {
  if (!forcePushTargetsDefaultBranch(command, defaultBranch)) return null;
  return `force-push to default branch (${localBaseRef(defaultBranch)}) is not allowed from loop agents`;
}

export function loopAgentForcePushDenialReason(
  command: string,
  defaultBranch: string,
): string | null {
  for (const segment of splitShellCommandSegments(command)) {
    const reason = loopAgentForcePushDenialReasonSingle(segment, defaultBranch);
    if (reason) return reason;
  }
  return null;
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
