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

/** Prefixed to a `$name` / `${…}` expansion outside single quotes; the value is unknown. */
const EXPANSION = "\u0001";

interface ScanState {
  i: number;
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  literal: boolean;
}

/** Commands run by `$(…)` / backtick substitutions inside otherwise-literal text (heredoc bodies). */
function scanSubstitutionsInText(text: string, dialect: ShellDialect, commands: string[][]): void {
  let i = 0;
  while (i < text.length) {
    if (dialect === "posix" && text[i] === "\\") {
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "(") {
      const st = { i: i + 2 };
      scanShell(text, dialect, st, ")", commands);
      i = st.i;
    } else if (dialect === "posix" && text[i] === "`") {
      const st = { i: i + 1 };
      scanShell(text, dialect, st, "`", commands);
      i = st.i;
    } else {
      i++;
    }
  }
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
  let heredocs: PendingHeredoc[] = [];
  const consumeHeredocBodies = (): void => {
    for (const doc of heredocs) {
      const body: string[] = [];
      while (st.i < src.length) {
        const nl = src.indexOf("\n", st.i);
        const lineEnd = nl < 0 ? src.length : nl;
        const line = src.slice(st.i, lineEnd).replace(/\r$/, "");
        st.i = nl < 0 ? src.length : nl + 1;
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        body.push(line);
      }
      if (!doc.literal) scanSubstitutionsInText(body.join("\n"), dialect, commands);
    }
    heredocs = [];
  };
  const readHeredocDelimiter = (): PendingHeredoc => {
    const stripTabs = src[st.i] === "-";
    if (stripTabs) st.i++;
    while (src[st.i] === " " || src[st.i] === "\t") st.i++;
    let raw = "";
    while (st.i < src.length && !/[\s;&|<>()]/.test(src[st.i])) {
      const c = src[st.i];
      if (c === "'" || c === '"') {
        const end = src.indexOf(c, st.i + 1);
        const stop = end < 0 ? src.length : end;
        raw += src.slice(st.i, stop + 1);
        st.i = stop + 1;
        continue;
      }
      raw += c;
      st.i++;
    }
    return {
      delimiter: raw.replace(/['"\\]/g, ""),
      stripTabs,
      literal: /['"\\]/.test(raw),
    };
  };
  const appendDollar = (): void => {
    if (/[A-Za-z0-9_{@*#?!]/.test(src[st.i + 1] ?? "")) cur += EXPANSION;
    cur += "$";
    inWord = true;
    st.i++;
  };
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
        } else if (c === "$") {
          appendDollar();
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
    if (ch === "$") {
      appendDollar();
      continue;
    }
    if (
      dialect === "powershell" &&
      ch === "@" &&
      !inWord &&
      (src[st.i + 1] === '"' || src[st.i + 1] === "'") &&
      /^[ \t]*\r?\n/.test(src.slice(st.i + 2))
    ) {
      const quote = src[st.i + 1];
      const bodyStart = src.indexOf("\n", st.i) + 1;
      const term = new RegExp(`\\r?\\n${quote}@`).exec(src.slice(bodyStart));
      const bodyEnd = term ? bodyStart + term.index : src.length;
      const body = src.slice(bodyStart, bodyEnd);
      if (quote === '"') scanSubstitutionsInText(body, dialect, commands);
      cur += body;
      inWord = true;
      st.i = term ? bodyEnd + term[0].length : src.length;
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
    if (ch === "\n") {
      endCommand();
      st.i++;
      consumeHeredocBodies();
      continue;
    }
    if (ch === "\r" || ch === ";" || ch === "&" || ch === "|") {
      endCommand();
      st.i++;
      continue;
    }
    if (ch === "<" && src[st.i + 1] === "<" && src[st.i + 2] !== "<") {
      endWord();
      st.i += 2;
      heredocs.push(readHeredocDelimiter());
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
      while (/[<>&|]/.test(src[st.i] ?? "")) st.i++;
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

/** Word whose value is only known at run time: `$X`, `${…}`, `$(…)`, backticks, `%X%`, `@splat`, `{}`. */
function isUnresolvedToken(word: string): boolean {
  return (
    word.includes(SUBSTITUTION) ||
    word.includes(EXPANSION) ||
    word.startsWith("$") ||
    /%[^%]+%/.test(word) ||
    word.startsWith("@") ||
    word.includes("{}")
  );
}

function isGhWord(words: string[], i: number): boolean {
  return commandBasename(words[i]) === "gh" || (i === 0 && isUnresolvedToken(words[0] ?? ""));
}

function isGitWord(words: string[], i: number): boolean {
  return commandBasename(words[i]) === "git" || (i === 0 && isUnresolvedToken(words[0] ?? ""));
}

/** Launchers that hand gh arguments assembled at run time (stdin, `-ArgumentList`, remote blocks). */
const GH_INDIRECT_LAUNCHERS = new Set([
  "xargs",
  "parallel",
  "start-process",
  "saps",
  "start",
  "invoke-command",
  "icm",
]);

interface GhInvocation {
  args: string[];
  /** False when the command word is unresolved (`$GH`) rather than a literal `gh`. */
  literal: boolean;
  launcher: string | null;
}

/** Launcher whose program operand is `words[ghIdx]` (only flags and flag values in between). */
function launcherFor(words: string[], ghIdx: number): string | null {
  for (let k = ghIdx - 1; k >= 0; k--) {
    const base = commandBasename(words[k]);
    if (GH_INDIRECT_LAUNCHERS.has(base)) return base;
    const isFlag = words[k].startsWith("-");
    const isFlagValue = k > 0 && words[k - 1].startsWith("-");
    if (!isFlag && !isFlagValue) return null;
  }
  return null;
}

/** Arguments after each `gh` word in a simple command, with any indirect launcher before it. */
function ghInvocations(words: string[]): GhInvocation[] {
  const out: GhInvocation[] = [];
  words.forEach((_, i) => {
    if (!isGhWord(words, i)) return;
    out.push({
      args: words.slice(i + 1),
      literal: commandBasename(words[i]) === "gh",
      launcher: launcherFor(words, i),
    });
  });
  return out;
}

/** Flags known to take a value somewhere in the gh command tree. */
const GH_KNOWN_VALUE_FLAGS = new Set([
  "-h",
  "--hostname",
  "-R",
  "--repo",
  "-u",
  "--user",
  "-p",
  "--git-protocol",
  "-s",
  "--scopes",
  "-e",
  "--env",
  "-o",
  "--org",
  "-a",
  "--app",
  "-b",
  "--body",
  "-r",
  "--repos",
  "-v",
  "--visibility",
  "-q",
  "--jq",
  "--template",
  "--json",
]);

type FlagReading = "boolean" | "cobra" | "known";

/**
 * First positional after `args[0..]`, reading flags one way: all boolean; cobra's subcommand lookup
 * (an unknown `--flag` or `-x` without `=` consumes the next word); or only known value flags.
 */
function firstPositional(
  args: string[],
  reading: FlagReading,
): { word: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      return i + 1 < args.length ? { word: args[i + 1], rest: args.slice(i + 2) } : null;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (t.includes("=")) continue;
      const consumes =
        reading === "cobra"
          ? t.startsWith("--") || t.length === 2
          : reading === "known" && GH_KNOWN_VALUE_FLAGS.has(t);
      if (consumes) i++;
      continue;
    }
    return { word: t, rest: args.slice(i + 1) };
  }
  return null;
}

function positionalCandidates(
  args: string[],
  readings: FlagReading[] = ["boolean", "cobra", "known"],
): { word: string; rest: string[] }[] {
  const out: { word: string; rest: string[] }[] = [];
  for (const reading of readings) {
    const hit = firstPositional(args, reading);
    if (hit && !out.some((o) => o.word === hit.word && o.rest.length === hit.rest.length)) {
      out.push(hit);
    }
  }
  return out;
}

const SPELL_LITERALLY =
  "spell the gh command literally (no variables, substitutions, splats, xargs or Start-Process)";

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
  fields: string[];
  hasInput: boolean;
}

/** Parse `gh api` arguments the way pflag does (attached `-fVAL`, `-X=POST`, `--input=FILE`). */
function parseGhApiArgs(args: string[]): GhApiCall {
  let explicit: string | null = null;
  let hasBody = false;
  let hasInput = false;
  const fields: string[] = [];
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
      if (name === "--input") hasInput = true;
      else if (GH_API_LONG_BODY_FLAGS.has(name)) fields.push(value ?? "");
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
      if (flag === "f" || flag === "F") {
        hasBody = true;
        fields.push(value);
      }
      continue;
    }
    positionals.push(t);
  }
  return { method: explicit ?? (hasBody ? "POST" : "GET"), positionals, fields, hasInput };
}

function ghApiDenialReason(apiArgs: string[]): string | null {
  const call = parseGhApiArgs(apiArgs);
  if (isUnresolvedToken(call.method) || call.positionals.some(isUnresolvedToken)) {
    return `gh api with a run-time method or endpoint is not allowed from loop agents; ${SPELL_LITERALLY}`;
  }
  const endpoints = call.positionals.map(normalizeGhApiEndpoint);
  if (endpoints.some((e) => e.toLowerCase() === "graphql")) {
    const blob = apiArgs.join(" ");
    if (GRAPHQL_REPO_LIFECYCLE.some((name) => blob.includes(name))) {
      return "gh api graphql repo create/delete/admin mutations are not allowed from loop agents";
    }
    const query = call.fields.find((f) => /^query=/i.test(f))?.slice("query=".length) ?? "";
    if (
      call.hasInput ||
      query.startsWith("@") ||
      query.includes(SUBSTITUTION) ||
      query.includes(EXPANSION)
    ) {
      return "gh api graphql with a query read from a file, stdin or variable is not allowed from loop agents; pass the query inline";
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

function ghGroupDenialReason(group: string, rest: string[]): string | null {
  if (GH_ALWAYS_DENIED.has(group)) return `gh ${group} is not allowed from loop agents`;
  if (group === "api") return ghApiDenialReason(rest);
  if (group === "auth") {
    if (rest.some((a) => /^(?:-t|--show-token)(?:=|$)/i.test(a))) {
      return "gh auth --show-token is not allowed from loop agents";
    }
    const subs = positionalCandidates(rest, ["cobra", "known"]);
    if (subs.some((s) => s.word.toLowerCase() !== "status")) {
      return "gh auth changes are not allowed from loop agents (except gh auth status)";
    }
    return null;
  }
  for (const sub of positionalCandidates(rest)) {
    const name = sub.word.toLowerCase();
    if (group === "repo" && GH_REPO_ADMIN_SUBCOMMANDS.has(name)) {
      return `gh repo ${name} is not allowed from loop agents`;
    }
    if (group === "alias" && ["set", "import", "delete"].includes(name)) {
      return `gh alias ${name} is not allowed from loop agents (aliases can rename denied commands)`;
    }
    if (GH_EXTENSION_GROUPS.has(group) && ["install", "upgrade", "exec"].includes(name)) {
      return `gh extension ${name} is not allowed from loop agents (extensions run arbitrary code)`;
    }
  }
  return null;
}

function ghDenialReason({ args, literal, launcher }: GhInvocation): string | null {
  if (launcher) {
    return `gh launched through ${launcher} is not allowed from loop agents; ${SPELL_LITERALLY}`;
  }
  if (!literal) {
    const a0 = args[0]?.toLowerCase() ?? "";
    return a0 ? ghGroupDenialReason(a0, args.slice(1)) : null;
  }
  for (const g of positionalCandidates(args)) {
    if (isUnresolvedToken(g.word)) {
      return `gh with a run-time command group is not allowed from loop agents; ${SPELL_LITERALLY}`;
    }
    const group = g.word.toLowerCase();
    if (group !== "api" && positionalCandidates(g.rest).some((s) => isUnresolvedToken(s.word))) {
      return `gh ${group} with a run-time subcommand is not allowed from loop agents; ${SPELL_LITERALLY}`;
    }
    const reason = ghGroupDenialReason(group, g.rest);
    if (reason) return reason;
  }
  return null;
}

/** True when gh api would mutate repo lifecycle endpoints (RAD-163 R1). */
export function ghApiRepoLifecycleMutation(command: string): boolean {
  for (const words of shellSimpleCommands(command)) {
    for (const { args } of ghInvocations(words)) {
      for (const g of positionalCandidates(args)) {
        if (g.word.toLowerCase() === "api" && ghApiDenialReason(g.rest)) return true;
      }
    }
  }
  return false;
}

/** Short reason string when a loop agent must not run this shell command; null if allowed. */
export function loopAgentShellDenialReason(command: string): string | null {
  for (const words of shellSimpleCommands(command)) {
    for (const inv of ghInvocations(words)) {
      const reason = ghDenialReason(inv);
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
    for (const { args } of ghInvocations(words)) {
      for (const g of positionalCandidates(args)) {
        const group = g.word.toLowerCase();
        for (const s of positionalCandidates(g.rest)) {
          const sub = s.word.toLowerCase();
          if (group === "pr" && (sub === "create" || sub === "merge")) return true;
          if (group === "repo" && sub === "create") return true;
        }
      }
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
