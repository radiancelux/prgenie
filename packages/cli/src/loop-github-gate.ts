import path from "node:path";
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

/** Resolved path for comparisons: separators and trailing slashes normalized; lower-cased on win32. */
export function normalizeFsPathForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return path.win32.resolve(p).toLowerCase();
  return path.posix.resolve(p);
}

export function isPathInsideOrEqual(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const c = normalizeFsPathForCompare(child, platform);
  const p = normalizeFsPathForCompare(parent, platform);
  if (c === p) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

type ShellDialect = "posix" | "powershell";

/** Stands in for a `$(…)` / backtick substitution whose output is unknown at parse time. */
const SUBSTITUTION = "\u0000";

interface ScanState {
  i: number;
}

function scanShell(
  src: string,
  dialect: ShellDialect,
  st: ScanState,
  closer: ")" | "`" | null,
  commands: string[][],
): void {
  const escapeCh = dialect === "posix" ? "\\" : "`";
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  let parenDepth = 0;
  let skipNextWord = false;
  const endWord = (): void => {
    if (inWord) {
      if (skipNextWord) skipNextWord = false;
      else words.push(cur);
    }
    cur = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    skipNextWord = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const substitution = (innerCloser: ")" | "`"): void => {
    scanShell(src, dialect, st, innerCloser, commands);
    cur += SUBSTITUTION;
    inWord = true;
  };

  while (st.i < src.length) {
    const ch = src[st.i];
    if (closer === "`" && ch === "`") {
      st.i++;
      endCommand();
      return;
    }
    if (closer === ")" && ch === ")" && parenDepth === 0) {
      st.i++;
      endCommand();
      return;
    }
    if (ch === escapeCh) {
      const next = src[st.i + 1];
      if (next === "\n") {
        st.i += 2;
      } else if (next === "\r" && src[st.i + 2] === "\n") {
        st.i += 3;
      } else if (next !== undefined) {
        cur += next;
        inWord = true;
        st.i += 2;
      } else {
        st.i++;
      }
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", st.i + 1);
      const stop = end < 0 ? src.length : end;
      cur += src.slice(st.i + 1, stop);
      inWord = true;
      st.i = stop + 1;
      continue;
    }
    if (ch === '"') {
      st.i++;
      inWord = true;
      while (st.i < src.length && src[st.i] !== '"') {
        const c = src[st.i];
        if (c === escapeCh && st.i + 1 < src.length) {
          cur += src[st.i + 1];
          st.i += 2;
        } else if (c === "$" && src[st.i + 1] === "(") {
          st.i += 2;
          substitution(")");
        } else if (dialect === "posix" && c === "`") {
          st.i++;
          substitution("`");
        } else {
          cur += c;
          st.i++;
        }
      }
      st.i++;
      continue;
    }
    if (ch === "$" && src[st.i + 1] === "(") {
      st.i += 2;
      substitution(")");
      continue;
    }
    if (dialect === "posix" && ch === "`") {
      st.i++;
      substitution("`");
      continue;
    }
    if (ch === "(") {
      endCommand();
      parenDepth++;
      st.i++;
      continue;
    }
    if (ch === ")") {
      endCommand();
      if (parenDepth > 0) parenDepth--;
      st.i++;
      continue;
    }
    if ((ch === "{" || ch === "}") && !inWord) {
      endCommand();
      st.i++;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "&" || ch === "|") {
      endCommand();
      st.i++;
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (inWord && /^\d+$/.test(cur)) {
        cur = "";
        inWord = false;
      } else {
        endWord();
      }
      st.i++;
      while (src[st.i] === ">" || src[st.i] === "&" || src[st.i] === "|") st.i++;
      skipNextWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      st.i++;
      continue;
    }
    cur += ch;
    inWord = true;
    st.i++;
  }
  endCommand();
}

function parseShell(command: string, dialect: ShellDialect): string[][] {
  const commands: string[][] = [];
  scanShell(command, dialect, { i: 0 }, null, commands);
  return commands;
}

const SHELL_EVAL_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "wsl",
  "eval",
  "iex",
  "invoke-expression",
]);

function commandBasename(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Every simple command (word list) the shell string could run: split on `;`, `&&`, `||`, `|`, `&`,
 * newlines, `(…)` / `{…}` groups, and the bodies of `$(…)` and backtick substitutions. Parsed once
 * with POSIX rules and once with PowerShell rules (backtick escape) so either reading is checked.
 * Arguments to `bash -c`, `pwsh -Command`, `eval`, `iex` and similar are parsed as nested commands.
 */
export function shellSimpleCommands(command: string): string[][] {
  const out: string[][] = [];
  const visit = (src: string, depth: number): void => {
    for (const dialect of ["posix", "powershell"] as const) {
      for (const words of parseShell(src, dialect)) {
        out.push(words);
        if (depth >= 4) continue;
        const evalIdx = words.findIndex((w) => SHELL_EVAL_COMMANDS.has(commandBasename(w)));
        if (evalIdx < 0) continue;
        const rest = words.slice(evalIdx + 1);
        for (const w of rest) {
          if (/\s/.test(w)) visit(w, depth + 1);
        }
        if (rest.length > 0) visit(rest.join(" "), depth + 1);
      }
    }
  };
  visit(command, 0);
  return out;
}

/** Command word whose value is only known at run time (`$GH`, `$(…)`, `%GH%`). */
function isUnresolvedCommandWord(words: string[], i: number): boolean {
  if (i !== 0) return false;
  const w = words[0] ?? "";
  return w.includes(SUBSTITUTION) || w.startsWith("$") || /%[^%]+%/.test(w);
}

function isGhWord(words: string[], i: number): boolean {
  return commandBasename(words[i]) === "gh" || isUnresolvedCommandWord(words, i);
}

function isGitWord(words: string[], i: number): boolean {
  return commandBasename(words[i]) === "git" || isUnresolvedCommandWord(words, i);
}

/** Argument lists after each `gh` word in a simple command. */
function ghInvocations(words: string[]): string[][] {
  const out: string[][] = [];
  words.forEach((_, i) => {
    if (isGhWord(words, i)) out.push(words.slice(i + 1));
  });
  return out;
}

const GH_API_LONG_VALUE_FLAGS = new Set([
  "--header",
  "--field",
  "--raw-field",
  "--input",
  "--jq",
  "--template",
  "--hostname",
  "--cache",
  "--preview",
  "--method",
]);

const GH_API_LONG_BODY_FLAGS = new Set(["--field", "--raw-field", "--input"]);

/** `gh api` shorthand flags that take no value; every other shorthand (-H -f -F -X -q -t -p) does. */
const GH_API_BOOL_SHORTHANDS = new Set(["i", "h"]);

const GRAPHQL_REPO_LIFECYCLE = [
  "createRepository",
  "deleteRepository",
  "updateRepository",
  "archiveRepository",
  "unarchiveRepository",
  "cloneTemplateRepository",
] as const;

function normalizeGhApiEndpoint(raw: string): string {
  return raw
    .replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, "")
    .replace(/^\/+/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function isRepoLifecycleEndpoint(endpoint: string): boolean {
  return (
    /^user\/repos$/i.test(endpoint) ||
    /^orgs\/[^/]+\/repos$/i.test(endpoint) ||
    /^repos\/[^/]+\/[^/]+$/i.test(endpoint) ||
    /^repos\/[^/]+\/[^/]+\/(?:transfer|forks|generate)$/i.test(endpoint)
  );
}

interface GhApiCall {
  method: string;
  positionals: string[];
}

/** Parse `gh api` arguments the way pflag does (attached `-fVAL`, `-X=POST`, `--input=FILE`). */
function parseGhApiArgs(args: string[]): GhApiCall {
  let explicit: string | null = null;
  let hasBody = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = (eq < 0 ? t : t.slice(0, eq)).toLowerCase();
      let value: string | null = eq < 0 ? null : t.slice(eq + 1);
      if (value === null && GH_API_LONG_VALUE_FLAGS.has(name)) {
        value = args[i + 1] ?? "";
        i++;
      }
      if (name === "--method") explicit = (value ?? "").toUpperCase();
      if (GH_API_LONG_BODY_FLAGS.has(name)) hasBody = true;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      let j = 1;
      while (j < t.length && GH_API_BOOL_SHORTHANDS.has(t[j])) j++;
      if (j >= t.length) continue;
      const flag = t[j];
      let value = t.slice(j + 1);
      if (value.startsWith("=")) value = value.slice(1);
      if (!value && t.length === j + 1) {
        value = args[i + 1] ?? "";
        i++;
      }
      if (flag === "X") explicit = value.toUpperCase();
      if (flag === "f" || flag === "F") hasBody = true;
      continue;
    }
    positionals.push(t);
  }
  return { method: explicit ?? (hasBody ? "POST" : "GET"), positionals };
}

function ghApiDenialReason(apiArgs: string[]): string | null {
  const call = parseGhApiArgs(apiArgs);
  const endpoints = call.positionals.map(normalizeGhApiEndpoint);
  if (endpoints.some((e) => e.toLowerCase() === "graphql")) {
    const blob = apiArgs.join(" ");
    if (GRAPHQL_REPO_LIFECYCLE.some((name) => blob.includes(name))) {
      return "gh api graphql repo create/delete/admin mutations are not allowed from loop agents";
    }
    return null;
  }
  if (call.method === "GET" || call.method === "HEAD") return null;
  if (endpoints.some(isRepoLifecycleEndpoint)) {
    return "gh api repo create/delete/admin mutations are not allowed from loop agents";
  }
  return null;
}

/** Repo admin subcommands; `fork` and `unarchive` also create or revive remote repos. */
const GH_REPO_ADMIN_SUBCOMMANDS = new Set([
  "create",
  "delete",
  "edit",
  "rename",
  "archive",
  "unarchive",
  "fork",
]);

const GH_ALWAYS_DENIED = new Set(["ssh-key", "gpg-key", "secret", "variable"]);

const GH_EXTENSION_GROUPS = new Set(["extension", "extensions", "ext"]);

function ghDenialReason(args: string[]): string | null {
  const a0 = args[0]?.toLowerCase() ?? "";
  const a1 = args[1]?.toLowerCase() ?? "";
  if (a0 === "repo" && GH_REPO_ADMIN_SUBCOMMANDS.has(a1)) {
    return `gh repo ${a1} is not allowed from loop agents`;
  }
  if (a0 === "auth" && a1 && !a1.startsWith("-")) {
    if (a1 !== "status") {
      return "gh auth changes are not allowed from loop agents (except gh auth status)";
    }
    if (args.some((a) => /^(?:-t|--show-token)(?:=|$)/i.test(a))) {
      return "gh auth status --show-token is not allowed from loop agents";
    }
  }
  if (GH_ALWAYS_DENIED.has(a0)) return `gh ${a0} is not allowed from loop agents`;
  if (a0 === "alias" && ["set", "import", "delete"].includes(a1)) {
    return `gh alias ${a1} is not allowed from loop agents (aliases can rename denied commands)`;
  }
  if (GH_EXTENSION_GROUPS.has(a0) && ["install", "upgrade", "exec"].includes(a1)) {
    return `gh extension ${a1} is not allowed from loop agents (extensions run arbitrary code)`;
  }
  if (a0 === "api") return ghApiDenialReason(args.slice(1));
  return null;
}

/** True when gh api would mutate repo lifecycle endpoints (RAD-163 R1). */
export function ghApiRepoLifecycleMutation(command: string): boolean {
  for (const words of shellSimpleCommands(command)) {
    for (const args of ghInvocations(words)) {
      if (args[0]?.toLowerCase() === "api" && ghApiDenialReason(args.slice(1))) return true;
    }
  }
  return false;
}

/** Short reason string when a loop agent must not run this shell command; null if allowed. */
export function loopAgentShellDenialReason(command: string): string | null {
  for (const words of shellSimpleCommands(command)) {
    for (const args of ghInvocations(words)) {
      const reason = ghDenialReason(args);
      if (reason) return reason;
    }
  }
  return null;
}

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/** Argument lists after each `git … push` in a simple command (git global options skipped). */
function gitPushInvocations(words: string[]): string[][] {
  const out: string[][] = [];
  words.forEach((_, k) => {
    if (!isGitWord(words, k)) return;
    let i = k + 1;
    while (i < words.length && words[i].startsWith("-")) {
      i += GIT_GLOBAL_VALUE_FLAGS.has(words[i]) ? 2 : 1;
    }
    if (words[i]?.toLowerCase() === "push") out.push(words.slice(i + 1));
  });
  return out;
}

const GIT_PUSH_LONG_VALUE_FLAGS = new Set(["--repo", "--push-option", "--receive-pack", "--exec"]);

interface GitPushPlan {
  force: boolean;
  deletes: boolean;
  allRefs: boolean;
  leaseRefs: string[];
  /** Destination refs; `null` entry means "the current branch". */
  destinations: (string | null)[];
  deletedRefs: string[];
}

function parseGitPush(args: string[]): GitPushPlan {
  const plan: GitPushPlan = {
    force: false,
    deletes: false,
    allRefs: false,
    leaseRefs: [],
    destinations: [],
    deletedRefs: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = (eq < 0 ? t : t.slice(0, eq)).toLowerCase();
      const attached = eq < 0 ? null : t.slice(eq + 1);
      if (name === "--force" || name === "--force-if-includes") plan.force = true;
      if (name === "--force-with-lease") {
        plan.force = true;
        if (attached) plan.leaseRefs.push(attached.split(":")[0] ?? "");
      }
      if (name === "--mirror") {
        plan.force = true;
        plan.allRefs = true;
      }
      if (name === "--all" || name === "--branches") plan.allRefs = true;
      if (name === "--delete") plan.deletes = true;
      if (attached === null && GIT_PUSH_LONG_VALUE_FLAGS.has(name)) i++;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      const cluster = t.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const c = cluster[j];
        if (c === "f") plan.force = true;
        if (c === "d") plan.deletes = true;
        if (c === "o") {
          if (j === cluster.length - 1) i++;
          break;
        }
      }
      continue;
    }
    positionals.push(t);
  }
  const refspecs = positionals.slice(1);
  for (const spec of refspecs) {
    let s = spec;
    if (s.startsWith("+")) {
      plan.force = true;
      s = s.slice(1);
    }
    const colon = s.lastIndexOf(":");
    const src = colon < 0 ? s : s.slice(0, colon);
    const dst = colon < 0 ? s : s.slice(colon + 1) || src;
    if (plan.deletes || (colon >= 0 && src === "")) {
      plan.deletedRefs.push(dst);
      continue;
    }
    plan.destinations.push(/^(?:HEAD|@)$/i.test(dst) ? null : dst);
  }
  if (refspecs.length === 0 && !plan.allRefs) plan.destinations.push(null);
  return plan;
}

/** True when `ref` names the default branch, or cannot be known at parse time (fail closed). */
function refIsDefaultBranch(
  ref: string | null,
  defaults: Set<string>,
  currentBranch: string | null | undefined,
): boolean {
  const resolved = ref ?? currentBranch;
  if (!resolved) return true;
  if (/[*$%]/.test(resolved) || resolved.includes(SUBSTITUTION)) return true;
  const name = resolved
    .replace(/^refs\/heads\//i, "")
    .replace(/^heads\//i, "")
    .toLowerCase();
  return defaults.has(name);
}

function gitPushDenialReason(
  args: string[],
  defaultBranch: string,
  currentBranch: string | null | undefined,
): string | null {
  const local = localBaseRef(defaultBranch);
  const defaults = new Set([local.toLowerCase(), "main"]);
  const plan = parseGitPush(args);
  if (plan.deletedRefs.some((r) => refIsDefaultBranch(r, defaults, currentBranch))) {
    return `deleting the default branch (${local}) is not allowed from loop agents`;
  }
  if (!plan.force) return null;
  const hitsDefault =
    plan.allRefs ||
    plan.leaseRefs.some((r) => refIsDefaultBranch(r, defaults, currentBranch)) ||
    plan.destinations.some((r) => refIsDefaultBranch(r, defaults, currentBranch));
  if (!hitsDefault) return null;
  return `force-push to default branch (${local}) is not allowed from loop agents`;
}

/** True when a force-push targets the repository default branch (RAD-163 R2). */
export function forcePushTargetsDefaultBranch(
  command: string,
  defaultBranch: string,
  currentBranch?: string | null,
): boolean {
  return loopAgentForcePushDenialReason(command, defaultBranch, currentBranch) !== null;
}

export function loopAgentForcePushDenialReason(
  command: string,
  defaultBranch: string,
  currentBranch?: string | null,
): string | null {
  for (const words of shellSimpleCommands(command)) {
    for (const args of gitPushInvocations(words)) {
      const reason = gitPushDenialReason(args, defaultBranch, currentBranch);
      if (reason) return reason;
    }
  }
  return null;
}

/** Tokenized publish detection: `git push`, `gh pr create|merge`, `gh repo create` anywhere. */
export function shellCommandPublishes(command: string): boolean {
  for (const words of shellSimpleCommands(command)) {
    if (gitPushInvocations(words).length > 0) return true;
    for (const args of ghInvocations(words)) {
      const a0 = args[0]?.toLowerCase();
      const a1 = args[1]?.toLowerCase();
      if (a0 === "pr" && (a1 === "create" || a1 === "merge")) return true;
      if (a0 === "repo" && a1 === "create") return true;
    }
  }
  return false;
}

export function loopAgentShellDenial(
  command: string,
  defaultBranch: string,
  currentBranch?: string | null,
): { permission: "deny"; user_message: string; agent_message: string } | null {
  const reason =
    loopAgentShellDenialReason(command) ??
    loopAgentForcePushDenialReason(command, defaultBranch, currentBranch);
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
