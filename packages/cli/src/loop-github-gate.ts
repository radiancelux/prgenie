import { readFileSync, readdirSync } from "node:fs";
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

/** Prefixed to a `$name` / `${…}` / `$'…'` expansion outside single quotes; the value is unknown. */
const EXPANSION = "\u0001";

/** Wraps the index of a `<(…)` / `>(…)` process substitution in this scan: `\u0002<n>\u0002`. */
const PROCSUB = "\u0002";

interface ScanState {
  i: number;
}

/** Text a command reads on stdin; `known: false` when it is only known at run time. */
interface StdinFeed {
  text: string;
  known: boolean;
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  literal: boolean;
  feed: StdinFeed;
}

interface ScannedCommand {
  words: string[];
  /** The only word is one quoted string or here-string (a PowerShell literal expression). */
  headQuoted: boolean;
  /** An escape character (`\` in POSIX, backtick in PowerShell) was used in this command. */
  hasEscapes: boolean;
  /** Heredocs, `<<<` here-strings and `<` redirects on this command. */
  stdin: StdinFeed[];
  /** Command whose output is piped into this one. */
  pipedFrom: ScannedCommand | null;
}

interface ScanSink {
  commands: string[][];
  /**
   * The same simple commands in order, with `"("` / `")"` around a context whose working directory
   * does not carry out: a POSIX `( … )` subshell, a `$( … )` / backtick / `<( … )` substitution,
   * and a PowerShell `{ … }` scriptblock (RAD-190 loop-target scan).
   */
  events: (string[] | "(" | ")")[];
  /** Literal scripts a shell or evaluator reads on stdin or from `<(…)`; parsed as commands. */
  scripts: string[];
  /** Shells or evaluators that run a script only known at run time. */
  unknownFeeds: string[];
}

function hasRunTimeValue(text: string): boolean {
  return text.includes(SUBSTITUTION) || text.includes(EXPANSION) || text.includes(PROCSUB);
}

/** A script argument whose text is not in the command: expansions, substitutions, `%VAR%`, `@splat`. */
function isRunTimeScript(arg: string): boolean {
  return hasRunTimeValue(arg) || /%[A-Za-z_]\w*%/.test(arg) || /^@[A-Za-z_(]/.test(arg);
}

/** Pipe source for `( … ) | iex`: the group's output is an expression, not literal text. */
const PAREN_SOURCE: ScannedCommand = {
  words: ["("],
  headQuoted: false,
  hasEscapes: false,
  stdin: [],
  pipedFrom: null,
};

/** Commands run by `$(…)` / backtick substitutions inside otherwise-literal text (heredoc bodies). */
function scanSubstitutionsInText(text: string, dialect: ShellDialect, sink: ScanSink): void {
  let i = 0;
  while (i < text.length) {
    if (dialect === "posix" && text[i] === "\\") {
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "(") {
      const st = { i: i + 2 };
      sink.events.push("(");
      scanShell(text, dialect, st, ")", sink);
      sink.events.push(")");
      i = st.i;
    } else if (dialect === "posix" && text[i] === "`") {
      const st = { i: i + 1 };
      sink.events.push("(");
      scanShell(text, dialect, st, "`", sink);
      sink.events.push(")");
      i = st.i;
    } else {
      i++;
    }
  }
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "wsl"]);
const POSIX_SHELL_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const PWSH_VALUE_PARAMS = [
  "executionpolicy",
  "workingdirectory",
  "configurationname",
  "outputformat",
  "inputformat",
  "windowstyle",
  "settingsfile",
  "custompipename",
  "version",
];
/** Prefix commands that run the rest of the line: their value-taking options and leading operands. */
const PREFIX_COMMANDS: Record<string, { values: string[]; operands?: number }> = {
  sudo: {
    values: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group"],
  },
  doas: { values: ["-u", "-C"] },
  runuser: { values: ["-u", "-g", "-G", "--user", "--group", "--supp-group"] },
  env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"] },
  nice: { values: ["-n", "--adjustment"] },
  timeout: { values: ["-s", "--signal", "-k", "--kill-after"], operands: 1 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  ionice: { values: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "-u"] },
  chrt: { values: [], operands: 1 },
  taskset: { values: [], operands: 1 },
  command: { values: [] },
  exec: { values: ["-a"] },
  nohup: { values: [] },
  time: { values: ["-f", "--format", "-o", "--output"] },
  "&": { values: [] },
  wsl: { values: ["-d", "--distribution", "-u", "--user", "--cd", "--shell-type"] },
};

function isParamPrefix(name: string, param: string, minLength = 1): boolean {
  return name.length >= minLength && param.startsWith(name);
}

/** pwsh reads its script from stdin: `pwsh`, `pwsh -`, `pwsh -Command -`, `pwsh -File -`. */
function pwshReadsStdin(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-") return true;
    if (!t.startsWith("-") && !t.startsWith("/")) return false;
    const name = t.replace(/^[-/]+/, "").toLowerCase();
    if (isParamPrefix(name, "command") || isParamPrefix(name, "file")) {
      return args[i + 1] === "-";
    }
    if (isParamPrefix(name, "encodedcommand") || name === "ec") return false;
    if (PWSH_VALUE_PARAMS.some((p) => isParamPrefix(name, p, 2))) i++;
  }
  return true;
}

/** sh/bash/… read their script from stdin unless `-c` or a script file is given (`-s` forces stdin). */
function posixShellReadsStdin(args: string[]): boolean {
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      positional ||= i + 1 < args.length;
      break;
    }
    if (POSIX_SHELL_VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t.slice(1).includes("c")) return false;
      if (t.slice(1).includes("s")) return true;
      continue;
    }
    if (t.startsWith("--")) continue;
    positional = true;
  }
  return !positional;
}

/**
 * True when a prefix option consumes the next word: `-u`, `--user`, or a short cluster whose last
 * flag takes a value (`-iu x`). A value flag earlier in a cluster has its value attached (`-ux`).
 */
function prefixOptionTakesNext(option: string, values: string[]): boolean {
  if (values.includes(option)) return true;
  if (option.startsWith("--") || !/^-[A-Za-z0-9]+$/.test(option)) return false;
  const cluster = option.slice(1);
  for (let j = 0; j < cluster.length; j++) {
    if (values.includes(`-${cluster[j]}`)) return j === cluster.length - 1;
  }
  return false;
}

/**
 * Index of the program word: past `VAR=value` assignments and prefix commands (`timeout 60`,
 * `nice -n 5`, `sudo -u x`, `env -i`, `stdbuf -oL`, `wsl -e`, …) with their options and operands.
 * A prefix with nothing after it is itself the program.
 */
function commandHeadIndex(words: string[]): number {
  let k = 0;
  for (;;) {
    while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k])) k++;
    const name = k < words.length ? commandBasename(words[k]) : "";
    const spec = Object.prototype.hasOwnProperty.call(PREFIX_COMMANDS, name)
      ? PREFIX_COMMANDS[name]
      : undefined;
    if (!spec) return k;
    let i = k + 1;
    while (i < words.length && words[i].startsWith("-") && words[i].length > 1) {
      if (words[i] === "--") {
        i++;
        break;
      }
      i += prefixOptionTakesNext(words[i], spec.values) ? 2 : 1;
    }
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    i += spec.operands ?? 0;
    if (i >= words.length) return k;
    k = i;
  }
}

const RUNNERS = new Set([
  ...POSIX_SHELLS,
  "pwsh",
  "powershell",
  "cmd",
  "eval",
  "iex",
  "invoke-expression",
  "source",
  ".",
]);

/** The shell or evaluator this command runs (past prefixes), or null. */
function runnerOf(words: string[]): string | null {
  const k = commandHeadIndex(words);
  const name = k < words.length ? commandBasename(words[k]) : "";
  return RUNNERS.has(name) ? name : null;
}

interface ScriptArguments {
  runner: string;
  /** Words that are (or name) the script the runner executes. */
  args: string[];
  /** `-EncodedCommand`: the script is never readable from the command text. */
  encoded: boolean;
  /** `inline`: the args are script text; `file`: the arg names a script file. */
  mode: "inline" | "file";
}

/**
 * The script operand of a shell or evaluator: `bash -c <script>`, `bash <file>`, `pwsh -Command …`,
 * `pwsh -File <file>`, `cmd /c …`, `eval …`, `iex …`, `source <file>` / `. <file>`.
 */
function scriptArguments(words: string[]): ScriptArguments | null {
  const k = commandHeadIndex(words);
  if (k >= words.length) return null;
  const runner = commandBasename(words[k]);
  const args = words.slice(k + 1);
  const result = (
    script: string[],
    mode: ScriptArguments["mode"] = "inline",
    encoded = false,
  ): ScriptArguments => ({ runner, args: script, encoded, mode });
  if (POSIX_SHELLS.has(runner) || runner === "source" || runner === ".") {
    let inline = false;
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      const mode = inline ? "inline" : "file";
      if (t === "--") return i + 1 < args.length ? result([args[i + 1]], mode) : null;
      if (POSIX_SHELL_VALUE_FLAGS.has(t)) {
        i++;
        continue;
      }
      if (/^[-+][A-Za-z]+$/.test(t)) {
        inline ||= t.slice(1).includes("c");
        continue;
      }
      if (t.startsWith("--")) continue;
      return result([t], mode);
    }
    return null;
  }
  if (runner === "pwsh" || runner === "powershell") {
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (t === "-") return null;
      if (!t.startsWith("-") && !t.startsWith("/")) return result(args.slice(i));
      const name = t.replace(/^[-/]+/, "").toLowerCase();
      if (isParamPrefix(name, "encodedcommand") || name === "ec") {
        return result([], "inline", true);
      }
      if (isParamPrefix(name, "command")) {
        const rest = args.slice(i + 1);
        return rest[0] === "-" ? null : result(rest);
      }
      if (isParamPrefix(name, "file")) return result(args.slice(i + 1, i + 2), "file");
      if (PWSH_VALUE_PARAMS.some((p) => isParamPrefix(name, p, 2))) i++;
    }
    return null;
  }
  if (runner === "cmd") {
    const idx = args.findIndex((a) => /^\/[ck]/i.test(a));
    if (idx < 0) return null;
    const attached = args[idx].slice(2);
    return result([...(attached ? [attached] : []), ...args.slice(idx + 1)]);
  }
  if (runner === "eval" || runner === "iex" || runner === "invoke-expression") {
    return args.length > 0 ? result(args) : null;
  }
  return null;
}

/** Name of the shell or evaluator when this command runs a script it reads on stdin. */
function shellStdinConsumer(words: string[]): string | null {
  const k = commandHeadIndex(words);
  if (k >= words.length) return null;
  const name = commandBasename(words[k]);
  const args = words.slice(k + 1);
  if (POSIX_SHELLS.has(name)) return posixShellReadsStdin(args) ? name : null;
  if (name === "pwsh" || name === "powershell") return pwshReadsStdin(args) ? name : null;
  if (name === "cmd") return args.some((a) => /^\/[ck]/i.test(a)) ? null : name;
  if (name === "iex" || name === "invoke-expression") {
    return args.some((a) => !a.startsWith("-") || /^-c/i.test(a)) ? null : name;
  }
  if (name === "eval") return args.length === 0 ? name : null;
  return null;
}

const ECHO_COMMANDS = new Set(["echo", "printf", "write-output", "write", "write-host"]);
const STDIN_PASSTHROUGH_COMMANDS = new Set(["cat", "type", "get-content", "gc"]);

/**
 * What `source` writes to a pipe, when that is known from the command text alone. Escapes, `printf`
 * format directives and `echo -e` are not decoded: that output counts as unknown.
 */
function pipedOutput(source: ScannedCommand): StdinFeed {
  const unknown = { text: "", known: false };
  if (source.hasEscapes) return unknown;
  const literal = (text: string): StdinFeed =>
    hasRunTimeValue(text) || text.includes("\\") ? unknown : { text, known: true };
  if (source.headQuoted) return literal(source.words[0]);
  const name = commandBasename(source.words[0] ?? "");
  const args = source.words.slice(1);
  if (name === "printf" && /[%\\]/.test(args[0] ?? "")) return unknown;
  if (ECHO_COMMANDS.has(name)) {
    const flags = name === "echo" ? args.filter((a) => /^-[neE]+$/.test(a)) : [];
    if (flags.some((f) => f.includes("e"))) return unknown;
    return literal(args.filter((a) => !flags.includes(a)).join(" "));
  }
  if (
    STDIN_PASSTHROUGH_COMMANDS.has(name) &&
    args.every((a) => a.startsWith("-")) &&
    source.stdin.length > 0
  ) {
    return {
      text: source.stdin.map((f) => f.text).join("\n"),
      known: source.stdin.every((f) => f.known),
    };
  }
  return unknown;
}

const XARGS_VALUE_FLAGS = new Set([
  "-L",
  "-n",
  "-P",
  "-s",
  "-d",
  "-E",
  "-a",
  "-R",
  "-S",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-lines",
  "--max-procs",
  "--max-chars",
  "--eof",
]);

/** `xargs [options] command…`: the command it launches and its replace string (`-I R`, `-i`). */
function xargsTarget(args: string[]): { target: string[]; replace: string | null } {
  let replace: string | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-") || t.length === 1) break;
    if (t === "-I" || t === "-J") {
      replace = args[++i] ?? null;
    } else if (/^-[IJ]./.test(t)) {
      replace = t.slice(2);
    } else if (t === "-i" || t === "--replace") {
      replace = "{}";
    } else if (/^-i./.test(t)) {
      replace = t.slice(2);
    } else if (t.startsWith("--replace=")) {
      replace = t.slice("--replace=".length) || "{}";
    } else if (XARGS_VALUE_FLAGS.has(t)) {
      i++;
    }
  }
  return { target: args.slice(i), replace };
}

/** Commands run by `find … -exec|-execdir|-ok|-okdir command… ;|+`. */
function findExecTargets(args: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
    const start = i + 1;
    while (i + 1 < args.length && !/^(?:;|\+|\\;?)$/.test(args[i + 1])) i++;
    out.push(args.slice(start, i + 1));
  }
  return out;
}

const START_PROCESS_COMMANDS = new Set(["start-process", "saps", "start"]);
const START_PROCESS_VALUE_PARAMS = [
  "filepath",
  "argumentlist",
  "args",
  "workingdirectory",
  "verb",
  "windowstyle",
  "redirectstandardinput",
  "redirectstandardoutput",
  "redirectstandarderror",
  "credential",
  "environment",
];
const START_PROCESS_SWITCHES = [
  "wait",
  "nonewwindow",
  "passthru",
  "loaduserprofile",
  "usenewenvironment",
];

/** `Start-Process <file> [-ArgumentList] …`: the program and its argument words. */
function startProcessTarget(args: string[]): { file: string | null; argWords: string[] } {
  let file: string | null = null;
  const argWords: string[] = [];
  let inArgs = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    const name = /^-[A-Za-z]+$/.test(t) ? t.slice(1).toLowerCase() : "";
    const params = [...START_PROCESS_VALUE_PARAMS, ...START_PROCESS_SWITCHES];
    const param = name
      ? params.find((p) => (inArgs ? p === name : isParamPrefix(name, p, 2)))
      : undefined;
    if (param) {
      inArgs = param === "argumentlist" || param === "args";
      if (param === "filepath") file = args[++i] ?? null;
      else if (!inArgs && START_PROCESS_VALUE_PARAMS.includes(param)) i++;
      continue;
    }
    if (inArgs || file !== null) {
      argWords.push(t);
      inArgs = true;
    } else if (!t.startsWith("-")) {
      file = t;
    }
  }
  return { file, argWords };
}

function resolveScripts(scanned: ScannedCommand[], procSubs: StdinFeed[], sink: ScanSink): void {
  const take = (runner: string, feed: StdinFeed): void => {
    if (feed.known) sink.scripts.push(feed.text);
    else if (!sink.unknownFeeds.includes(runner)) sink.unknownFeeds.push(runner);
  };
  const unknown: StdinFeed = { text: "", known: false };
  const checkScript = (script: ScriptArguments): void => {
    if (script.encoded) take(script.runner, unknown);
    for (const arg of script.args) {
      const sub = new RegExp(`^${PROCSUB}(\\d+)${PROCSUB}$`).exec(arg);
      if (sub) take(script.runner, procSubs[Number(sub[1])] ?? unknown);
      else if (isRunTimeScript(arg)) take(script.runner, unknown);
    }
  };
  /** A runner started by xargs / find -exec: its script may come from the launcher's input. */
  const checkLaunched = (target: string[], replace: string | null, appendsInput: boolean): void => {
    const runner = runnerOf(target);
    if (!runner) return;
    const script = scriptArguments(target);
    if (
      !script ||
      (replace !== null && script.args.some((a) => a.includes(replace))) ||
      (appendsInput && script.mode === "inline" && !POSIX_SHELLS.has(runner))
    ) {
      take(runner, unknown);
      return;
    }
    checkScript(script);
  };
  for (const cmd of scanned) {
    const consumer = shellStdinConsumer(cmd.words);
    if (consumer) {
      const feeds = cmd.pipedFrom ? [...cmd.stdin, pipedOutput(cmd.pipedFrom)] : cmd.stdin;
      for (const feed of feeds) take(consumer, feed);
    }
    const script = scriptArguments(cmd.words);
    if (script) checkScript(script);
    const k = commandHeadIndex(cmd.words);
    const head = commandBasename(cmd.words[k] ?? "");
    const rest = cmd.words.slice(k + 1);
    if (head === "xargs" || head === "parallel") {
      const { target, replace } = xargsTarget(rest);
      const sources = head === "parallel" ? target.findIndex((w) => /^:{3,4}\+?$/.test(w)) : -1;
      checkLaunched(
        sources < 0 ? target : target.slice(0, sources),
        replace ?? (head === "parallel" ? "{}" : null),
        true,
      );
    } else if (head === "find") {
      for (const target of findExecTargets(rest)) checkLaunched(target, "{}", false);
    } else if (START_PROCESS_COMMANDS.has(head)) {
      const { file, argWords } = startProcessTarget(rest);
      if (!file) continue;
      if (isRunTimeScript(file)) {
        take(head, unknown);
        continue;
      }
      const runner = runnerOf([file]);
      if (!runner) continue;
      if (argWords.some(isRunTimeScript)) take(runner, unknown);
      else sink.scripts.push([file, ...argWords].join(" ").replace(/,/g, " "));
    }
  }
}

function scanShell(
  src: string,
  dialect: ShellDialect,
  st: ScanState,
  closer: ")" | "`" | null,
  sink: ScanSink,
): ScannedCommand[] {
  const escapeCh = dialect === "posix" ? "\\" : "`";
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  let parenDepth = 0;
  /** PowerShell `{`: true when it opened a scriptblock context (see the `{` case below). */
  const braceGroups: boolean[] = [];
  let skipNextWord = false;
  let hereStringNext = false;
  let headQuoted = false;
  let headStart = 0;
  let hasEscapes = false;
  const procSubs: StdinFeed[] = [];
  let stdin: StdinFeed[] = [];
  let pipeSource: ScannedCommand | null = null;
  let lastScanned: ScannedCommand | null = null;
  const scanned: ScannedCommand[] = [];
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
      const text = body.join("\n");
      doc.feed.text = text;
      doc.feed.known = doc.literal || !/[$`]/.test(text);
      if (!doc.literal) scanSubstitutionsInText(text, dialect, sink);
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
    const feed: StdinFeed = { text: "", known: false };
    stdin.push(feed);
    return {
      delimiter: raw.replace(/['"\\]/g, ""),
      stripTabs,
      literal: /['"\\]/.test(raw),
      feed,
    };
  };
  const appendDollar = (): void => {
    if (/[A-Za-z0-9_{@*#?!'"]/.test(src[st.i + 1] ?? "")) cur += EXPANSION;
    cur += "$";
    inWord = true;
    st.i++;
  };
  const endWord = (): void => {
    if (inWord && headQuoted && words.length === 0) {
      const head = src.slice(headStart, st.i);
      if (!/^(?:'[^']*'|"[^"]*"|@'[\s\S]*'@|@"[\s\S]*"@)$/.test(head)) headQuoted = false;
    }
    if (inWord) {
      if (hereStringNext) {
        hereStringNext = false;
        stdin.push({ text: cur, known: !hasRunTimeValue(cur) });
      } else if (skipNextWord) {
        skipNextWord = false;
      } else {
        words.push(cur);
      }
    }
    cur = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    skipNextWord = false;
    hereStringNext = false;
    if (words.length > 0) {
      sink.commands.push(words);
      sink.events.push(words);
      lastScanned = {
        words,
        headQuoted: headQuoted && words.length === 1,
        hasEscapes,
        stdin,
        pipedFrom: pipeSource,
      };
      scanned.push(lastScanned);
      pipeSource = null;
      stdin = [];
    }
    headQuoted = false;
    hasEscapes = false;
    words = [];
  };
  const markQuotedHead = (): void => {
    if (!inWord && words.length === 0) {
      headQuoted = true;
      headStart = st.i;
    }
  };
  const finish = (): ScannedCommand[] => {
    endCommand();
    resolveScripts(scanned, procSubs, sink);
    return scanned;
  };
  const followsParenGroup = (): boolean => {
    let j = st.i - 1;
    while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
    return src[j] === ")";
  };
  const substitution = (innerCloser: ")" | "`"): void => {
    sink.events.push("(");
    scanShell(src, dialect, st, innerCloser, sink);
    sink.events.push(")");
    cur += SUBSTITUTION;
    inWord = true;
  };

  while (st.i < src.length) {
    const ch = src[st.i];
    if (closer === "`" && ch === "`") {
      st.i++;
      return finish();
    }
    if (closer === ")" && ch === ")" && parenDepth === 0) {
      st.i++;
      return finish();
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
        hasEscapes = true;
        st.i += 2;
      } else {
        st.i++;
      }
      continue;
    }
    if (ch === "'") {
      markQuotedHead();
      const end = src.indexOf("'", st.i + 1);
      const stop = end < 0 ? src.length : end;
      cur += src.slice(st.i + 1, stop);
      inWord = true;
      st.i = stop + 1;
      continue;
    }
    if (ch === '"') {
      markQuotedHead();
      st.i++;
      inWord = true;
      while (st.i < src.length && src[st.i] !== '"') {
        const c = src[st.i];
        if (c === escapeCh && st.i + 1 < src.length) {
          cur += src[st.i + 1];
          hasEscapes = true;
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
      if (quote === '"') scanSubstitutionsInText(body, dialect, sink);
      markQuotedHead();
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
    if ((ch === "<" || ch === ">") && src[st.i + 1] === "(") {
      st.i += 2;
      sink.events.push("(");
      const inner = scanShell(src, dialect, st, ")", sink);
      sink.events.push(")");
      procSubs.push(
        ch === "<" && inner.length === 1 ? pipedOutput(inner[0]) : { text: "", known: false },
      );
      cur += `${PROCSUB}${procSubs.length - 1}${PROCSUB}`;
      inWord = true;
      continue;
    }
    if (ch === "(") {
      if (inWord || words.length > 0) {
        endWord();
        words.push(SUBSTITUTION);
      }
      endCommand();
      if (dialect === "posix") sink.events.push("(");
      parenDepth++;
      st.i++;
      continue;
    }
    if (ch === ")") {
      endCommand();
      if (parenDepth > 0) {
        parenDepth--;
        if (dialect === "posix") sink.events.push(")");
      }
      st.i++;
      continue;
    }
    if (
      (ch === "{" || ch === "}") &&
      !inWord &&
      (dialect === "powershell" || posixBraceIsReserved(src, st.i, words))
    ) {
      endCommand();
      if (dialect === "powershell") {
        // A `{` that opens a command (`{ cd x; }; git push`) reads as a POSIX brace group, which
        // carries its `cd`; any other `{` (after `)` or a word: `foreach (…) { … }`) is a
        // scriptblock, whose location change is treated as not carrying out.
        if (ch === "{") {
          let j = st.i - 1;
          while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
          const opensCommand = j < 0 || /[;&|\n{(]/.test(src[j]);
          braceGroups.push(!opensCommand);
          if (!opensCommand) sink.events.push("(");
        } else if (braceGroups.pop()) {
          sink.events.push(")");
        }
      }
      st.i++;
      continue;
    }
    if (ch === "\n") {
      endCommand();
      st.i++;
      consumeHeredocBodies();
      continue;
    }
    if (ch === "|" && src[st.i + 1] !== "|") {
      const fromGroup = followsParenGroup();
      endCommand();
      pipeSource = fromGroup ? PAREN_SOURCE : lastScanned;
      st.i += src[st.i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "|") {
      endCommand();
      st.i += 2;
      continue;
    }
    if (ch === "\r" || ch === ";" || ch === "&") {
      endCommand();
      st.i++;
      continue;
    }
    if (ch === "<" && src[st.i + 1] === "<" && src[st.i + 2] === "<") {
      endWord();
      st.i += 3;
      hereStringNext = true;
      continue;
    }
    if (ch === "<" && src[st.i + 1] === "<") {
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
      if (ch === "<" && src[st.i + 1] !== "&" && src[st.i + 1] !== "(") {
        stdin.push({ text: "", known: false });
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
  return finish();
}

function parseShell(command: string, dialect: ShellDialect): ScanSink {
  const sink: ScanSink = { commands: [], events: [], scripts: [], unknownFeeds: [] };
  scanShell(command, dialect, { i: 0 }, null, sink);
  return sink;
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
 * Arguments to `bash -c`, `pwsh -Command`, `eval`, `iex` and similar are parsed as nested commands,
 * and so is literal stdin a shell or evaluator reads (heredoc, `<<<`, `echo … | bash`, `'…' | iex`).
 */
let lastAnalyzed: {
  command: string;
  result: { commands: string[][]; unknownFeeds: string[] };
} | null = null;

/** {@link analyzeShellUncached} with a one-entry cache: the gate asks about the same command often. */
function analyzeShell(command: string): { commands: string[][]; unknownFeeds: string[] } {
  if (lastAnalyzed?.command === command) return lastAnalyzed.result;
  const result = analyzeShellUncached(command);
  lastAnalyzed = { command, result };
  return result;
}

function analyzeShellUncached(command: string): { commands: string[][]; unknownFeeds: string[] } {
  const out: string[][] = [];
  const unknownFeeds = new Set<string>();
  const visit = (src: string, depth: number): void => {
    for (const dialect of ["posix", "powershell"] as const) {
      const sink = parseShell(src, dialect);
      for (const name of sink.unknownFeeds) unknownFeeds.add(name);
      for (const script of sink.scripts) {
        if (depth >= 4) unknownFeeds.add("nested shell");
        else visit(script, depth + 1);
      }
      for (const words of sink.commands) {
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
  return { commands: out, unknownFeeds: [...unknownFeeds] };
}

type ShellEvent = string[] | "(" | ")";

/**
 * One ordered event list per dialect reading (POSIX, PowerShell): simple commands with `"("` /
 * `")"` around contexts whose working directory does not carry out (see {@link ScanSink.events}).
 * Scripts run by a nested shell (`bash -c`, `| sh`) are appended as their own context; `eval` /
 * `iex` scripts run in the current shell, so they are inlined after the evaluating command.
 */
export function shellEventPasses(command: string): ShellEvent[][] {
  const passes: ShellEvent[][] = [];
  const visit = (src: string, dialect: ShellDialect, depth: number, out: ShellEvent[]): void => {
    const sink = parseShell(src, dialect);
    for (const ev of sink.events) {
      out.push(ev);
      if (typeof ev === "string" || depth >= 4) continue;
      const evalIdx = ev.findIndex((w) => SHELL_EVAL_COMMANDS.has(commandBasename(w)));
      if (evalIdx >= 0 && evalIdx + 1 < ev.length) {
        // As in analyzeShell: each multi-word argument, then the arguments joined.
        const rest = ev.slice(evalIdx + 1);
        for (const w of rest) if (/\s/.test(w)) visit(w, dialect, depth + 1, out);
        visit(rest.join(" "), dialect, depth + 1, out);
      }
    }
    for (const script of sink.scripts) {
      if (depth >= 4) continue;
      out.push("(");
      visit(script, dialect, depth + 1, out);
      out.push(")");
    }
  };
  for (const dialect of ["posix", "powershell"] as const) {
    const out: ShellEvent[] = [];
    visit(command, dialect, 0, out);
    passes.push(out);
  }
  return passes;
}

export function shellSimpleCommands(command: string): string[][] {
  return analyzeShell(command).commands;
}

/** Word whose value is only known at run time: `$X`, `${…}`, `$(…)`, backticks, `%X%`, `@splat`, `{}`. */
function isUnresolvedToken(word: string): boolean {
  return (
    word.includes(SUBSTITUTION) ||
    word.includes(EXPANSION) ||
    word.includes(PROCSUB) ||
    word.startsWith("$") ||
    /%[^%]+%/.test(word) ||
    isPowerShellSplat(word) ||
    word.includes("{}")
  );
}

/**
 * A PowerShell splat or array expression (`@a`, `@args`, a bare `@` before `(…)`, `@(`, `@{`,
 * or a here-string `@'…`), never a scoped package name like `@prgenie/cli` (RAD-190 round 5).
 */
function isPowerShellSplat(word: string): boolean {
  if (!word.startsWith("@")) return false;
  return /^@(?:[A-Za-z_]\w*)?$/.test(word) || /^@[({'"\s]/.test(word);
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
  const { commands, unknownFeeds } = analyzeShell(command);
  for (const words of commands) {
    for (const inv of ghInvocations(words)) {
      const reason = ghDenialReason(inv);
      if (reason) return reason;
    }
  }
  if (unknownFeeds.length > 0) {
    return `${unknownFeeds[0]} running a script that is not in the command text (variable, command output, file, process substitution, escapes or -EncodedCommand) is not allowed from loop agents; pass the script literally (for example bash -c '…') so it can be checked`;
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

/**
 * `git push --help` / `git push -h` print usage and never push (RAD-190 R3). Only the first argument
 * after `push` counts, so a flag value (`-o -h`, `--push-option -h`, `--repo -h`) is never read as help.
 */
function gitPushIsHelp(args: string[]): boolean {
  return args[0] === "--help" || args[0] === "-h";
}

/** Tokenized publish detection: `git push`, `gh pr create|merge`, `gh repo create` anywhere. */
export function shellCommandPublishes(command: string): boolean {
  const lines: string[][] = [];
  for (const words of shellSimpleCommands(command)) {
    lines.push(words);
    // `Start-Process git -ArgumentList 'push','origin'`: read the line it launches (RAD-190).
    const head = commandHeadIndex(words);
    if (
      START_PROCESS_COMMANDS.has(commandBasename(words[head] ?? "")) &&
      words.some((w, i) => i > head && (isGitWord(words, i) || isGhWord(words, i)))
    ) {
      lines.push(...(startProcessCommandLines(words, head) ?? []));
    }
  }
  for (const words of lines) {
    if (gitPushInvocations(words).some((args) => !gitPushIsHelp(args))) return true;
    for (const { args } of ghInvocations(words)) {
      for (const g of positionalCandidates(args)) {
        const group = g.word.toLowerCase();
        for (const s of positionalCandidates(g.rest)) {
          const sub = s.word.toLowerCase();
          if (group === "pr" && (sub === "create" || sub === "merge")) return true;
          if (group === "repo" && sub === "create") return true;
          // RAD-190 loop-only scope: releases publish too (loop agents only, like every publish deny).
          if (
            group === "release" &&
            ["create", "upload", "edit", "delete", "delete-asset"].includes(sub)
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** Human-only prgenie CLI subcommand an agent shell command would run (RAD-190 R1). */
export type PrgenieHumanOnlyCli =
  "export" | "export-gate-override" | "gh use" | "run-time" | "too-complex";

const PRGENIE_PACKAGE = /^(?:prgenie|@prgenie\/cli)(?:@[^\s/]*)?$/i;
/** Root `package.json` scripts that run the CLI (`pnpm cli …`), plus `pnpm prgenie …`. */
const PRGENIE_SCRIPT_NAMES = new Set(["cli", "prgenie"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const NODE_RUNNERS = new Set(["node", "nodejs", "tsx", "bun"]);
const PM_VALUE_FLAGS = new Set([
  "-C",
  "--dir",
  "-F",
  "--filter",
  "--prefix",
  "-w",
  "--workspace",
  "--cwd",
  "--reporter",
  "--loglevel",
  "-p",
  "--package",
  "--call",
  "-c",
]);
const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
  "--tsconfig",
]);
/** Script files that are the PR Genie CLI entry: built `prgenie.cjs`, a `cli.js` copy, or the TS sources. */
function isPrgenieCliScript(word: string): boolean {
  const base = commandBasename(word);
  if (/^prgenie(?:\.[cm]?js)?$/.test(base)) return true;
  if (/^cli\.[cm]?js$/.test(base)) return true;
  const normalized = word.replace(/\\/g, "/").toLowerCase();
  return /^(?:bin|cli)\.ts$/.test(base) && /(?:^|\/)(?:packages\/cli|prgenie)\//.test(normalized);
}

/**
 * The PR Genie bin itself: `prgenie`, `prgenie.cmd`, `prgenie.ps1`, `…/dist/prgenie.cjs`, `.exe`, or a
 * Deno `npm:` specifier (`deno run npm:prgenie`).
 */
function isPrgenieBinWord(word: string): boolean {
  if (/^npm:(?:prgenie|@prgenie\/cli)(?:@[^\s/]*)?$/i.test(word)) return true;
  return /^prgenie(?:\.(?:cmd|bat|ps1|cjs|mjs|js))?$/.test(commandBasename(word));
}

/**
 * Commands whose arguments are data, never run: a `prgenie export` after one of these in the same
 * simple command is a mention (`echo prgenie export`, `rg "…" docs`), not a CLI launch.
 */
const DATA_ONLY_COMMANDS = new Set([
  "echo",
  "printf",
  "write-host",
  "write-output",
  "write-error",
  "write-warning",
  "write-verbose",
  "write-information",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "findstr",
  "select-string",
  "sls",
  "cat",
  "type",
  "less",
  "more",
  "head",
  "tail",
  "get-content",
  "gc",
]);
/** git subcommands that never run another program from their arguments. */
const GIT_DATA_SUBCOMMANDS = new Set([
  "commit",
  "log",
  "show",
  "grep",
  "tag",
  "notes",
  "shortlog",
  "blame",
  "add",
  "diff",
  "status",
]);

/** cmd `^` and PowerShell backtick escapes vanish when the command runs (`pr^genie` is `prgenie`). */
function unescapeWord(word: string): string {
  return word.replace(/[\^`]/g, "");
}

/** Wrappers that run the next word as the program; skipped (with their options) to find the program. */
const PROGRAM_WRAPPERS = new Set(["call", "builtin"]);
/** Launchers that run their first non-option word as a program, with their value options. */
const ARG_LAUNCHERS = new Map<string, Set<string>>([
  [
    "xargs",
    new Set([
      "-I",
      "-i",
      "-n",
      "-L",
      "-l",
      "-P",
      "-s",
      "-d",
      "-E",
      "-e",
      "-a",
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-lines",
      "--max-procs",
      "--max-chars",
      "--replace",
      "--eof",
    ]),
  ],
]);
/** `watch` options that take the next word as their value (procps-ng). */
const WATCH_VALUE_FLAGS = new Set(["-n", "--interval", "-q", "--equexit"]);

interface LauncherWalk {
  /** Index of the program word, past prefixes, `call`, `builtin` and `xargs` / `watch -x`. */
  k: number;
  /** An `xargs` was passed: the launched program gets more arguments from its input. */
  xargs: boolean;
  /** `watch` without `-x`: index of its first script word (it runs them joined with `sh -c`). */
  watchScript: number;
}

/**
 * Walks past prefix wrappers to the program a simple command runs. `xargs` (with its options) runs
 * its first word as a program. `watch -x` / `--exec` does too, but plain `watch` joins its
 * arguments and runs them with `sh -c`, so it stops the walk as a script runner.
 */
function launcherWalk(words: string[]): LauncherWalk {
  let k = commandHeadIndex(words);
  let xargs = false;
  for (;;) {
    while (k < words.length && PROGRAM_WRAPPERS.has(commandBasename(words[k]))) k++;
    const name = commandBasename(words[k] ?? "");
    if (name === "watch") {
      let j = k + 1;
      let exec = false;
      while (j < words.length && words[j].startsWith("-") && words[j].length > 1) {
        const w = words[j];
        if (w === "--") {
          j++;
          break;
        }
        if (w === "--exec" || /^-[A-Za-wyz]*x/.test(w)) exec = true;
        j += WATCH_VALUE_FLAGS.has(w) || /^-[A-Za-z]*[nq]$/.test(w) ? 2 : 1;
      }
      if (!exec) return { k, xargs, watchScript: Math.min(j, words.length) };
      k = j;
    } else if (name === "xargs") {
      xargs = true;
      const valueFlags = ARG_LAUNCHERS.get("xargs") ?? NO_VALUE_FLAGS;
      k++;
      while (k < words.length && words[k].startsWith("-") && words[k].length > 1) {
        if (words[k] === "--") {
          k++;
          break;
        }
        k += valueFlags.has(words[k]) ? 2 : 1;
      }
    } else {
      break;
    }
    k += commandHeadIndex(words.slice(k, k + 64));
  }
  return { k, xargs, watchScript: -1 };
}
/** Runners whose script is the word after a script switch (`-c`, `-Command`, `/c`, `/k`). */
const SCRIPT_RUNNERS = new Set([
  ...POSIX_SHELLS,
  "pwsh",
  "powershell",
  "cmd",
  "eval",
  "iex",
  "invoke-expression",
]);

/** `-c`, `-lc`, `-ec`, `--command`, `-Command` and its prefixes, `/c`, `/k`, `/r`. */
function isScriptSwitch(word: string): boolean {
  const w = word.toLowerCase();
  if (/^\/[ckr]$/.test(w)) return true;
  if (/^-[a-z]*c$/.test(w) && w.length <= 4) return true;
  if (w === "--command") return true;
  const name = w.replace(/^-+/, "");
  return w.startsWith("-") && name.length >= 1 && "command".startsWith(name);
}

/**
 * Words of the program a simple command actually runs: past prefix wrappers and their options
 * (`sudo -u x`, `env -C dir`, `timeout 5`, `call`), and for a shell or evaluator (or a re-parsed
 * runner tail like `/c echo …`) the first words of its script. Computed once per simple command.
 */
function effectiveProgram(words: string[], walk = launcherWalk(words)): string[] {
  // `xargs -n 1 echo …` / `watch -x echo …`: the launched program is the program. Plain `watch`
  // is a script runner: its script is checked on its own (see prgenieCliHumanOnlyWords).
  let k = walk.k;
  if (walk.watchScript >= 0) return words.slice(k, k + 1);
  if (k >= words.length) return [];
  const reparsedTail = /^[-/]/.test(words[k]);
  if (reparsedTail) {
    // A re-parsed Start-Process list tail (`-c,echo …`): its leading words are comma-separated.
    words = [
      ...words.slice(k, k + 8).flatMap((w) => w.split(",").filter(Boolean)),
      ...words.slice(k + 8),
    ];
    k = 0;
  }
  const name = commandBasename(words[k]);
  if (SCRIPT_RUNNERS.has(name) || reparsedTail) {
    const from = reparsedTail ? k : k + 1;
    if (name === "eval" || name === "iex" || name === "invoke-expression") {
      return (words[k + 1] ?? "").trim().split(/\s+/).slice(0, 8);
    }
    // The script is the word after the first script switch among the leading options.
    for (let j = from; j < words.length && j < from + 32; j++) {
      if (isScriptSwitch(words[j])) {
        const first = (words[j + 1] ?? "").trim().replace(/^&\s*/, "").split(/\s+/);
        return [...first.slice(0, 8), ...words.slice(j + 2, j + 10)];
      }
    }
    if (reparsedTail) {
      let j = k;
      while (j < words.length && /^[-/]/.test(words[j])) j++;
      return words.slice(j, j + 8);
    }
  }
  return words.slice(k, k + 8);
}

/** True when the program a simple command runs only prints or searches its arguments. */
function runsDataOnlyCommand(words: string[], walk = launcherWalk(words)): boolean {
  let program = effectiveProgram(words, walk);
  while (program.length > 0 && PROGRAM_WRAPPERS.has(commandBasename(program[0]))) {
    program = program.slice(1);
  }
  if (program.length === 0) return false;
  const name = commandBasename(program[0]);
  if (DATA_ONLY_COMMANDS.has(name)) return true;
  if (name !== "git") return false;
  let k = 1;
  while (k < program.length && program[k].startsWith("-")) {
    k += GIT_GLOBAL_VALUE_FLAGS.has(program[k]) ? 2 : 1;
  }
  return k < program.length && GIT_DATA_SUBCOMMANDS.has(program[k].toLowerCase());
}

const NO_VALUE_FLAGS = new Set<string>();
/** `npx -c '…'` / `npm exec -c '…'` / `--call`: a command string the package runner executes. */
const PM_CALL_FLAGS = new Set(["-c", "--call"]);

/**
 * Indices of the first non-flag word at or after `i`, skipping flag values. Value flags are read both
 * ways (consuming the next word, or boolean) because pnpm and npm disagree on some (`-w`).
 */
function skipFlags(words: string[], i: number, valueFlags: Set<string>): number[] {
  const out = new Set<number>();
  for (const flags of [valueFlags, NO_VALUE_FLAGS]) {
    let k = i;
    while (k < words.length) {
      const t = words[k];
      if (t === "--") {
        k++;
        break;
      }
      if (!t.startsWith("-") || t.length < 2) break;
      k += !t.includes("=") && flags.has(t) ? 2 : 1;
    }
    out.add(k);
  }
  return [...out];
}

/** Literal `-c '…'` / `--call=…` command strings in a simple command that runs a package runner. */
function packageRunnerCalls(words: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const t = words[k];
    if (PM_CALL_FLAGS.has(t) && k + 1 < words.length) out.push(words[k + 1]);
    else if (t.startsWith("--call=")) out.push(t.slice("--call=".length));
  }
  return out;
}

interface PrgenieCliStart {
  /** Index of the first CLI argument in `words`. */
  args: number;
}

/** Where the PR Genie CLI arguments start when `words[i]` launches the CLI; empty when it does not. */
function prgenieCliArgsStarts(words: string[], i: number, depth = 0): PrgenieCliStart[] {
  const word = words[i];
  if (word === undefined || depth > 3) return [];
  const name = commandBasename(word).replace(/\.(?:cmd|bat|ps1)$/, "");
  if (isPrgenieBinWord(word)) return [{ args: i + 1 }];
  if (name === "corepack") return prgenieCliArgsStarts(words, i + 1, depth + 1);
  const out: PrgenieCliStart[] = [];
  const pkgAt = (k: number): void => {
    if (k < words.length && PRGENIE_PACKAGE.test(words[k])) out.push({ args: k + 1 });
  };
  if (PACKAGE_RUNNERS.has(name)) {
    for (const k of skipFlags(words, i + 1, PM_VALUE_FLAGS)) pkgAt(k);
    return out;
  }
  if (NODE_RUNNERS.has(name)) {
    for (const k of skipFlags(words, i + 1, NODE_VALUE_FLAGS)) {
      if (k < words.length && isPrgenieCliScript(words[k])) out.push({ args: k + 1 });
    }
    if (name !== "bun") return out;
  }
  if (!PACKAGE_MANAGERS.has(name)) return out;
  for (const k of skipFlags(words, i + 1, PM_VALUE_FLAGS)) {
    const verb = words[k]?.toLowerCase();
    if (verb === undefined) continue;
    if (verb === "exec" || verb === "dlx" || verb === "x") {
      for (const j of skipFlags(words, k + 1, PM_VALUE_FLAGS)) pkgAt(j);
    } else if (verb === "run" || verb === "run-script") {
      for (const j of skipFlags(words, k + 1, PM_VALUE_FLAGS)) {
        if (PRGENIE_SCRIPT_NAMES.has(words[j]?.toLowerCase() ?? "")) out.push({ args: j + 1 });
      }
    } else if (PRGENIE_SCRIPT_NAMES.has(verb) || PRGENIE_PACKAGE.test(verb)) {
      out.push({ args: k + 1 });
    }
  }
  return out;
}

/** Human-only subcommand named by the PR Genie CLI arguments `args[from..]`, or null. No copying. */
function prgenieHumanOnlySubcommand(args: string[], from = 0): PrgenieHumanOnlyCli | null {
  // Leading flags are skipped (fail closed: `prgenie --verbose export`).
  const [i] = skipFlags(args, from, NO_VALUE_FLAGS);
  const sub = args[i];
  if (sub === undefined) return null;
  if (isUnresolvedToken(sub)) return "run-time";
  const s = sub.toLowerCase();
  if (s === "export" || s === "export-gate-override") return s;
  if (s === "gh" || s === "github") {
    // The CLI reads the word right after `gh` (`prgenie gh --verbose use` is not `gh use`).
    const verb = args[i + 1];
    if (verb === undefined) return null;
    if (isUnresolvedToken(verb) || verb.toLowerCase() === "use") return "gh use";
  }
  return null;
}

/**
 * Start-Process parameters with their aliases, as `(Get-Command Start-Process).Parameters` reports
 * them in PowerShell 7.6 (common parameters included): `true` when the parameter takes a value.
 * Note `-RunAs` is the alias of `-Credential` (a value), and `-wa` is `-WarningAction`, not `-Wait`.
 */
const START_PROCESS_PARAMETERS: [string, boolean, string[]][] = [
  ["filepath", true, ["pspath", "path"]],
  ["argumentlist", true, ["args"]],
  ["credential", true, ["runas"]],
  ["workingdirectory", true, []],
  ["loaduserprofile", false, ["lup"]],
  ["nonewwindow", false, ["nnw"]],
  ["passthru", false, []],
  ["redirectstandarderror", true, ["rse"]],
  ["redirectstandardinput", true, ["rsi"]],
  ["redirectstandardoutput", true, ["rso"]],
  ["verb", true, []],
  ["windowstyle", true, []],
  ["wait", false, []],
  ["usenewenvironment", false, []],
  ["environment", true, []],
  ["verbose", false, ["vb"]],
  ["debug", false, ["db"]],
  ["erroraction", true, ["ea"]],
  ["warningaction", true, ["wa"]],
  ["informationaction", true, ["infa"]],
  ["progressaction", true, ["proga"]],
  ["errorvariable", true, ["ev"]],
  ["warningvariable", true, ["wv"]],
  ["informationvariable", true, ["iv"]],
  ["outvariable", true, ["ov"]],
  ["outbuffer", true, ["ob"]],
  ["pipelinevariable", true, ["pv"]],
  ["whatif", false, ["wi"]],
  ["confirm", false, ["cf"]],
];

type StartProcessParam = "filepath" | "argumentlist" | "value" | "switch" | "ambiguous";

/**
 * How Start-Process binds `-name`: an exact name or alias first, then an unambiguous prefix of a
 * name or alias (PowerShell's rule). An ambiguous prefix (`-e`, `-W`) is an error in PowerShell;
 * it is `ambiguous` here and its value is read as arguments too (fail closed). Null when `word` is
 * not a parameter name.
 */
function startProcessParam(word: string): StartProcessParam | null {
  if (!/^-[A-Za-z]/.test(word)) return null;
  const name = word.slice(1).replace(/:.*$/, "").toLowerCase();
  const kind = (p: [string, boolean, string[]]): StartProcessParam =>
    p[0] === "filepath" || p[0] === "argumentlist" ? p[0] : p[1] ? "value" : "switch";
  const exact = START_PROCESS_PARAMETERS.find((p) => p[0] === name || p[2].includes(name));
  if (exact) return kind(exact);
  const hits = START_PROCESS_PARAMETERS.filter(
    (p) => p[0].startsWith(name) || p[2].some((a) => a.startsWith(name)),
  );
  if (hits.length === 1) return kind(hits[0]);
  return hits.length > 1 ? "ambiguous" : null;
}

/** Items of a Start-Process argument list value: split on commas and spaces, without `@(…)` / `(…)`. */
function splitArgumentList(value: string): string[] {
  return (/^@?\(.*\)$/s.test(value) ? value.replace(/^@?\(|\)$/g, "") : value)
    .split(/[\s,]+/)
    .map((a) => a.replace(/^['"]|['"]$/g, ""))
    .filter((a) => a.length > 0);
}

/**
 * `Start-Process <program> [-ArgumentList] <list>` / `-FilePath <program> -ArgumentList <list>` in
 * any order, as the command lines it launches: the program plus every `-ArgumentList` value (each
 * split on commas and spaces), and, when the parameter is repeated, the program plus each value on
 * its own too. Reads the whole simple command from `words[i]` once (no word or argument cap: a cap
 * would fall open). Null when `words[i]` is not Start-Process or names no program.
 */
function startProcessCommandLines(
  words: string[],
  i: number,
  ambiguousAsSwitch = false,
): string[][] | null {
  if (!START_PROCESS_COMMANDS.has(commandBasename(words[i] ?? ""))) return null;
  let program: string | null = null;
  let ambiguous = false;
  const lists: string[][] = [];
  const positionals: string[] = [];
  const split = splitArgumentList;
  for (let k = i + 1; k < words.length; k++) {
    const t = words[k];
    const param = startProcessParam(t);
    if (param === "switch") continue;
    if (param === "ambiguous") {
      ambiguous = true;
      if (ambiguousAsSwitch) continue;
    }
    if (param) {
      const colon = t.indexOf(":");
      const value = colon >= 0 ? t.slice(colon + 1) : words[++k];
      if (value === undefined) break;
      if (param === "filepath") program = value;
      // An ambiguous parameter's value is read as an argument list too (fail closed).
      else if (param === "argumentlist" || param === "ambiguous") lists.push(split(value));
      continue;
    }
    if (t.startsWith("-") || t.startsWith("/")) continue;
    positionals.push(t);
  }
  if (program === null) program = positionals.shift() ?? null;
  // The second positional is the argument list. PowerShell refuses a third one (nothing runs).
  if (positionals.length > 0) lists.push(split(positionals[0]));
  if (program === null) return null;
  const all = lists.flat();
  const out = [[program, ...all]];
  if (lists.length > 1) for (const list of lists) out.push([program, ...list]);
  // Extra positionals (refused by PowerShell) get the word scan too, but not the script re-read.
  if (positionals.length > 1) out.push([program, ...positionals.flatMap(split)]);
  // PowerShell refuses an ambiguous parameter; it is read both as taking a value and as a switch.
  if (ambiguous && !ambiguousAsSwitch)
    out.push(...(startProcessCommandLines(words, i, true) ?? []));
  return out;
}

/** Human-only subcommand when a PR Genie launch starts at `words[i]` (constant work per word). */
function prgenieLaunchAt(words: string[], i: number): PrgenieHumanOnlyCli | null {
  const starts = prgenieCliArgsStarts(words, i);
  if (i > 0 && isPrgenieCliScript(words[i])) starts.push({ args: i + 1 });
  for (const start of starts) {
    const sub = prgenieHumanOnlySubcommand(words, start.args);
    if (sub) return sub;
  }
  return null;
}

/** Substring every PR Genie launch word contains (bin, package manager or runner, CLI script). */
const LAUNCH_HINT = /prgenie|cli|bin\.ts|np[mx]|pnp|yarn|bun|corepack|node|tsx|start|saps/i;

/**
 * Work budget for one top-level PR Genie CLI check. Every nested re-read (Start-Process lines,
 * quoted pwsh scripts, `watch` scripts, `npx -c`) draws on it. The limit is deterministic work
 * units (characters re-read plus words scanned), so the same command always gets the same answer;
 * a 5s clock is only a backstop against a slow or loaded machine. Rebuilding a Start-Process
 * line is not charged on its own (RAD-190 R6 nit 3): its words are charged when the rebuilt line is
 * scanned, and the nesting itself (Start-Process inside Start-Process) is bounded by the 5s clock. When either runs out the check
 * stops and the command is denied as `too-complex` (fail closed), so no input can fall open.
 */
interface CliBudget {
  deadline: number;
  work: number;
  /** Simple commands already checked (the tokenizer reports nested ones more than once). */
  seen: Set<string>;
}
let cliBudget: CliBudget | null = null;
let CLI_BUDGET_MS = 5000;
let CLI_BUDGET_WORK = 8_000_000;

/** Tests only: change the CLI check budget; returns a function that restores it. */
export function setPrgenieCliBudgetForTests(ms: number, work: number): () => void {
  const saved = [CLI_BUDGET_MS, CLI_BUDGET_WORK] as const;
  CLI_BUDGET_MS = ms;
  CLI_BUDGET_WORK = work;
  return () => {
    [CLI_BUDGET_MS, CLI_BUDGET_WORK] = saved;
  };
}
class CliBudgetExhausted extends Error {}

function spendCliBudget(work: number): void {
  if (!cliBudget) return;
  cliBudget.work += work;
  if (cliBudget.work > CLI_BUDGET_WORK || Date.now() > cliBudget.deadline) {
    throw new CliBudgetExhausted("PR Genie CLI check budget exhausted");
  }
}

/** Index of the program after PowerShell call / dot-source operators (`& $exe`, `. $exe`). */
function pastCallOperators(words: string[], k: number): number {
  while (k < words.length - 1 && (words[k] === "&" || words[k] === ".")) k++;
  return k;
}

/** Human-only subcommand a run-time program (`$P`, `$(…)`) runs with the literal words after it. */
function runTimeProgramSubcommand(words: string[], from: number): PrgenieHumanOnlyCli | null {
  // PowerShell array arguments (`& $exe 'export','lp-1'`) arrive as one comma-joined word.
  const args = words[from]?.includes(",")
    ? [...splitArgumentList(words[from]), ...words.slice(from + 1, from + 3)]
    : words.slice(from, from + 3);
  const sub = prgenieHumanOnlySubcommand(args, 0);
  return sub && sub !== "run-time" ? sub : null;
}

/**
 * The human-only subcommand one simple command's words would run, or null. Linear in the words: the
 * data-only check, the run-time-program rule (`$P export`), a launch check at every word, one
 * Start-Process read (the first Start-Process word; later ones are its arguments) whose launched
 * command line gets this same full scan, `watch` scripts, and `npx -c` scripts.
 */
function prgenieCliHumanOnlyWords(
  words: string[],
  depth: number,
  raw: string[] = words,
): PrgenieHumanOnlyCli | null {
  // A simple command already checked at this depth found nothing then and finds nothing now.
  if (cliBudget) {
    const key = `${depth}\u0002${raw.join("\u0003")}`;
    if (cliBudget.seen.has(key)) return null;
    cliBudget.seen.add(key);
  }
  spendCliBudget(words.length);
  const walk = launcherWalk(words);
  if (walk.watchScript >= 0) {
    // Plain `watch` runs `sh -c "<its arguments joined>"`: check that script, like `bash -c`.
    // The raw words keep backticks (`watch echo '`prgenie export`'` substitutes under sh).
    const script = raw.slice(walk.watchScript).join(" ");
    if (depth >= 3) return LAUNCH_HINT.test(script) ? "too-complex" : null;
    return prgenieCliHumanOnlyCommand(script, depth + 1);
  }
  if (runsDataOnlyCommand(words, walk)) return null;
  // A command word only known at run time (`$P export lp-1`, `& $exe export`, `. $exe export`,
  // `& (Get-Command prgenie) export`) is treated as prgenie, like `$GH`.
  const head = pastCallOperators(words, commandHeadIndex(words));
  if (head < words.length && isUnresolvedToken(words[head])) {
    const sub = runTimeProgramSubcommand(words, head + 1);
    if (sub) return sub;
  }
  // `xargs prgenie` with no literal subcommand gets it from its input: decided at run time.
  if (walk.xargs && walk.k < words.length) {
    const starts = prgenieCliArgsStarts(words, walk.k);
    if (isPrgenieCliScript(words[walk.k])) starts.push({ args: walk.k + 1 });
    for (const start of starts) {
      const [i] = skipFlags(words, start.args, NO_VALUE_FLAGS);
      if (i >= words.length) return "run-time";
      if (/^(?:gh|github)$/i.test(words[i]) && i + 1 >= words.length) return "gh use";
    }
  }
  let packageRunner = false;
  let pwshRunner = false;
  let startProcess = -1;
  for (let i = 0; i < words.length; i++) {
    if (/^(?:pwsh|powershell|iex|invoke-expression)(?:\.exe)?$/i.test(words[i])) pwshRunner = true;
    // Cheap pre-filter: every launch form names one of these.
    if (!LAUNCH_HINT.test(words[i])) continue;
    const name = commandBasename(words[i]).replace(/\.(?:cmd|bat|ps1)$/, "");
    if (PACKAGE_RUNNERS.has(name) || PACKAGE_MANAGERS.has(name)) packageRunner = true;
    const sub = prgenieLaunchAt(words, i);
    if (sub) return sub;
    if (startProcess < 0 && START_PROCESS_COMMANDS.has(name)) startProcess = i;
  }
  if (startProcess >= 0) {
    const lines = startProcessCommandLines(words, startProcess) ?? [];
    // Each launched command line gets the full word scan: prefixes (`env A=1 prgenie`), a run-time
    // program (`-FilePath $exe -ArgumentList export`), runners.
    for (const line of lines) {
      const launched = depth < 3 ? prgenieCliHumanOnlyWords(line, depth + 1) : null;
      if (launched) return launched;
    }
    // The joined launch (program plus every list) is re-read as script text once, and only when
    // an argument holds shell structure (`-c 'echo x; prgenie …'`).
    const joined = lines[0];
    if (joined && joined.some((w) => /[;&|\n<>(){}`$]/.test(w))) {
      if (depth >= 3) return "too-complex";
      const launched = prgenieCliHumanOnlyCommand(joined.join(" "), depth + 1);
      if (launched) return launched;
    }
  }
  // A PowerShell script quoted inside `pwsh -c "…"` / `iex '…'` gets the `(…)` / `@(…)` / `@{…}`
  // reading too. The shared tokenizer already read it as is, so only a changed text is re-read.
  if (pwshRunner && depth < 3) {
    for (const w of words) {
      if (!/\s/.test(w) || !/[(@]/.test(w)) continue;
      const normalized = normalizePowerShellGroups(w);
      if (normalized === w) continue;
      const nested = prgenieCliHumanOnlyCommand(normalized, depth + 1, false);
      if (nested) return nested;
    }
  }
  // `npx -c '…'` / `npm exec --call …` scripts, collected once per simple command.
  if (packageRunner && depth < 3) {
    for (const call of packageRunnerCalls(words)) {
      const nested = prgenieCliHumanOnlyCommand(call, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** A PowerShell list expression of quoted strings or numbers: `'a','b'`, `"a";"b"` in `@(…)`. */
const LIST_ITEM = `(?:'[^']*'|"[^"\`$]*"|-?\\d+)`;
const PAREN_LIST = new RegExp(`^\\s*${LIST_ITEM}(?:\\s*,\\s*${LIST_ITEM})*\\s*$`);
const ARRAY_LIST = new RegExp(`^\\s*${LIST_ITEM}(?:\\s*[,;\\n]\\s*${LIST_ITEM})*\\s*$`);
const LIST_ITEMS = new RegExp(LIST_ITEM, "g");

interface OpenParen {
  /** Index in the output of `(` (or of the `@` of `@(`). */
  at: number;
  kind: "paren" | "array" | "none";
  /** Holds another group: never a flat literal list. */
  nested: boolean;
}

/**
 * PowerShell forms the shared tokenizer splits, rewritten for the PR Genie CLI check only (one
 * linear pass, quotes respected; the check reads both the original and this text, so the rewrite
 * can only add denies):
 * - a literal list `('a','b')` / `@('a','b')` / `@("a";"b")` becomes `'a','b'` (one argument word);
 * - any other `(…)` / `@(…)` in word position becomes `$(…)`: a run-time word, with or without a
 *   member or index after it (`(Get-Command prgenie)`, `((…).Source)`, `(…)[0].Source`,
 *   `('prg'+'enie')`), whose inner command is still checked;
 * - a `;` or newline inside `@{…}` becomes `,`, so a hash table does not end the command.
 */
function normalizePowerShellGroups(command: string): string {
  const out: string[] = [];
  const parens: OpenParen[] = [];
  let hashDepth = 0;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "`" && quote === '"') {
        out.push(c);
        i++;
        if (i < command.length) out.push(command[i]);
        continue;
      }
      out.push(c);
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "`") {
      out.push(c);
      i++;
      if (i < command.length) out.push(command[i]);
      continue;
    } else if (c === "@" && command[i + 1] === "{") {
      hashDepth++;
      out.push("@{");
      i++;
      continue;
    } else if (hashDepth > 0 && c === "{") {
      hashDepth++;
    } else if (hashDepth > 0 && c === "}") {
      hashDepth--;
    } else if (hashDepth > 0 && (c === ";" || c === "\n")) {
      out.push(",");
      continue;
    } else if (c === "(") {
      const prev = i > 0 ? command[i - 1] : " ";
      const top = parens[parens.length - 1];
      if (top) top.nested = true;
      if (prev === "@") parens.push({ at: out.length - 1, kind: "array", nested: false });
      else if (/[\s=,;|&{(:]/.test(prev))
        parens.push({ at: out.length, kind: "paren", nested: false });
      else parens.push({ at: out.length, kind: "none", nested: false });
    } else if (c === ")") {
      const open = parens.pop();
      if (open && open.kind !== "none") {
        const from = open.at + (open.kind === "array" ? 2 : 1);
        if (!open.nested) {
          const content = out.slice(from).join("");
          if ((open.kind === "array" ? ARRAY_LIST : PAREN_LIST).test(content)) {
            out.length = open.at;
            out.push((content.match(LIST_ITEMS) ?? []).join(","));
            continue;
          }
        }
        if (open.kind === "array") out[open.at] = "$";
        else out[open.at] = "$(";
      }
    }
    out.push(c);
  }
  return out.join("");
}

/**
 * The human-only PR Genie CLI subcommand (`export`, `export-gate-override`, `gh use`) an agent shell
 * command would run (RAD-190 R1). A PR Genie launch is looked for at every word position, like
 * `git push` and `gh`: the bin, `pnpm cli` / `pnpm prgenie` / `pnpm exec` / `npx` / `npm exec`, a CLI
 * script (`<path>/prgenie.cjs`, `cli.js`, `packages/cli/src/bin.ts`) under any runner, after any
 * prefix or launcher (`call`, `start /b`, `setsid`, `env -S`, `su -c`, …), through Start-Process,
 * and inside `cmd /c` / `pwsh -c` / `bash -c` / `watch` scripts. Words after a data-only command
 * (`echo`, `rg`, `git commit`, …) are mentions. `run-time` when the subcommand is only known at run
 * time (`prgenie $SUB`); `too-complex` when the check ran out of its time or work budget. Null when
 * none.
 */
export function prgenieCliHumanOnlyCommand(
  command: string,
  depth = 0,
  withOriginal = true,
): PrgenieHumanOnlyCli | null {
  if (depth === 0 && cliBudget === null) {
    cliBudget = { deadline: Date.now() + CLI_BUDGET_MS, work: 0, seen: new Set() };
    try {
      return prgenieCliHumanOnlyCommand(command, depth, withOriginal);
    } catch (e) {
      if (e instanceof CliBudgetExhausted) return "too-complex";
      throw e;
    } finally {
      cliBudget = null;
    }
  }
  const texts = withOriginal ? [command] : [];
  if (/[(@]/.test(command)) {
    const normalized = normalizePowerShellGroups(command);
    if (normalized !== command || !withOriginal) texts.push(normalized);
  }
  for (const text of texts) {
    spendCliBudget(text.length);
    for (const raw of shellSimpleCommands(text)) {
      const sub = prgenieCliHumanOnlyWords(raw.map(unescapeWord), depth, raw);
      if (sub) return sub;
    }
  }
  return null;
}

/** True when `p` is a PR Genie loop worktree (`<repo>.loops/lp-xxxxxxxx`) or inside one. */
export function pathInLoopWorktree(p: string): boolean {
  let cur = path.resolve(p);
  // Cheap test first: a loop worktree path always has a `<name>.loops` segment.
  if (!/\.loops[\\/]/i.test(cur)) return false;
  for (;;) {
    if (loopWorktreeIdentity(cur)) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

const CD_COMMANDS = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
/** Set-Location / Push-Location parameters (pwsh 7.6) that take a value but are not the path. */
const LOCATION_VALUE_PARAMS = [
  "stackname",
  "erroraction",
  "warningaction",
  "informationaction",
  "progressaction",
  "errorvariable",
  "warningvariable",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
];
const LOCATION_VALUE_ALIASES = new Set([
  "ea",
  "wa",
  "infa",
  "proga",
  "ev",
  "wv",
  "iv",
  "ov",
  "ob",
  "pv",
]);
const LOCATION_PATH_PARAMS = ["path", "literalpath"];
const LOCATION_PATH_ALIASES = new Set(["pspath", "lp"]);

/** Bounds for {@link shellCommandPathTargets}; past either the targets are `"unresolved"`. */
const PATH_TARGET_LIMIT = 16_384;
const PATH_TARGET_BASES_LIMIT = 4096;
const PATH_TARGET_WORK_LIMIT = 200_000;

function locationParamKind(word: string): "path" | "value" | "switch" {
  const name = word.slice(1).replace(/:.*$/, "").toLowerCase();
  if (LOCATION_PATH_ALIASES.has(name)) return "path";
  if (LOCATION_VALUE_ALIASES.has(name)) return "value";
  if (name && LOCATION_PATH_PARAMS.some((p) => p.startsWith(name))) return "path";
  if (name && LOCATION_VALUE_PARAMS.some((p) => p.startsWith(name))) return "value";
  return "switch";
}

/** `-WorkingDirectory` (or an unambiguous prefix of it) for Start-Process; no alias in pwsh 7.6. */
function isStartProcessWorkingDirectory(word: string): boolean {
  if (!/^-[A-Za-z]/.test(word)) return false;
  const name = word.slice(1).replace(/:.*$/, "").toLowerCase();
  const hits = START_PROCESS_PARAMETERS.filter(
    (p) => p[0].startsWith(name) || p[2].some((a) => a.startsWith(name)),
  );
  const exact = START_PROCESS_PARAMETERS.find((p) => p[0] === name || p[2].includes(name));
  return (exact ?? (hits.length === 1 ? hits[0] : null))?.[0] === "workingdirectory";
}

/** A word without the tokenizer's leading run-time markers. */
function stripRunTimeMarkers(word: string): string {
  let w = word;
  while (w.startsWith(EXPANSION) || w.startsWith(SUBSTITUTION) || w.startsWith(PROCSUB)) {
    w = w.slice(1);
  }
  return w;
}

/**
 * Directories a glob word matches (`*`, `?`, `[…]`), resolved against each base; the word itself
 * when nothing matches (as bash does). Null when the walk runs out of work (`overBudget`).
 */
function expandGlob(
  word: string,
  bases: Iterable<string>,
  overBudget: () => boolean,
): string[] | null {
  const segRe = (seg: string): RegExp =>
    new RegExp(
      `^${seg
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
        .replace(/\[!/g, "[^")}$`,
    );
  const out = new Set<string>();
  for (const base of bases) {
    const abs = path.resolve(base, word);
    const root = path.parse(abs).root;
    let dirs = [root];
    for (const seg of abs.slice(root.length).split(path.sep)) {
      if (seg === "") continue;
      const next: string[] = [];
      for (const d of dirs) {
        if (overBudget()) return null;
        if (!/[*?[]/.test(seg)) {
          next.push(path.join(d, seg));
          continue;
        }
        let names: string[] = [];
        try {
          names = readdirSync(d);
        } catch {
          /* not a directory */
        }
        const re = segRe(seg);
        for (const n of names) {
          if (overBudget()) return null;
          if (re.test(n) && (seg.startsWith(".") || !n.startsWith("."))) next.push(path.join(d, n));
        }
      }
      dirs = next;
    }
    if (dirs.length === 0) out.add(abs);
    for (const d of dirs) out.add(d);
  }
  return [...out];
}

/** Words after which a POSIX `{` / `}` is still in command position (`do { …; }`, `! { …; }`). */
const POSIX_GROUP_PREFIX = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
]);

/**
 * POSIX `{` / `}` is a reserved word (brace group) only as a standalone word in command position:
 * `{` followed by whitespace or the end, `}` followed by a separator. Anything else
 * (`{x,y}`, `{1..3}`, `a{b}`) is part of a word and goes to brace expansion.
 */
function posixBraceIsReserved(src: string, i: number, words: string[]): boolean {
  const next = src[i + 1];
  const commandPosition =
    words.length === 0 || (words.length === 1 && POSIX_GROUP_PREFIX.has(words[0]));
  if (!commandPosition) return false;
  if (src[i] === "{") return next === undefined || /\s/.test(next);
  return next === undefined || /[\s;&|)]/.test(next);
}

/** Most words one brace expansion may produce before it fails closed. */
const BRACE_EXPANSION_LIMIT = 4096;

/**
 * Bash brace expansion of one word: `{a,b}` (nested), `{1..3}`, `{a..c}` (with an optional
 * step). Null when the result would pass {@link BRACE_EXPANSION_LIMIT} or `overBudget` (fail closed).
 */
function expandBraces(word: string, overBudget: () => boolean): string[] | null {
  const out: string[] = [];
  const pending = [word];
  while (pending.length > 0) {
    const w = pending.pop() as string;
    if (overBudget() || out.length + pending.length > BRACE_EXPANSION_LIMIT) return null;
    // Find the first `{` whose matching `}` encloses a top-level `,` or a `..` range.
    let done = true;
    for (let i = 0; i < w.length && done; i++) {
      if (w[i] !== "{") continue;
      let depth = 0;
      const commas: number[] = [];
      let j = i;
      for (; j < w.length; j++) {
        // The scan itself is charged to the budget (deeply nested `{{{…}}}`).
        if ((j & 63) === 0 && overBudget()) return null;
        if (w[j] === "{") depth++;
        else if (w[j] === "}") {
          depth--;
          if (depth === 0) break;
        } else if (w[j] === "," && depth === 1) commas.push(j);
      }
      if (j >= w.length) break;
      const pre = w.slice(0, i);
      const body = w.slice(i + 1, j);
      const post = w.slice(j + 1);
      if (commas.length > 0) {
        let start = i + 1;
        const parts: string[] = [];
        for (const c of commas) {
          parts.push(w.slice(start, c));
          start = c + 1;
        }
        parts.push(w.slice(start, j));
        for (const part of parts.reverse()) pending.push(pre + part + post);
        done = false;
        continue;
      }
      const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
      if (range) {
        const numeric = /\d/.test(range[1]) && /\d/.test(range[2]);
        if (!numeric && (/\d/.test(range[1]) || /\d/.test(range[2]))) continue;
        const a = numeric ? Number(range[1]) : range[1].charCodeAt(0);
        const b = numeric ? Number(range[2]) : range[2].charCodeAt(0);
        const step = Math.max(1, Math.abs(Number(range[3] ?? 1)));
        if (Math.abs(b - a) / step + 1 + out.length + pending.length > BRACE_EXPANSION_LIMIT) {
          return null;
        }
        const items: string[] = [];
        for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
          items.push(numeric ? String(v) : String.fromCharCode(v));
        }
        for (const item of items.reverse()) pending.push(pre + item + post);
        done = false;
      }
    }
    if (done) out.push(w);
  }
  return out;
}

/** Shell words that may precede `cd` in a simple command without changing what it does. */
const CD_LEADING_WORDS = new Set([
  "builtin",
  "command",
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
]);

export interface PathScan {
  /** Every directory the command may move to or point git at (lexical, not canonical). */
  targets: string[];
  /** A scan bound (targets, bases or work) was hit; `targets` is then incomplete. */
  overBound: boolean;
  /**
   * A run-time or unmodelled target reaches a `git` / `gh` command in the same shell context in
   * every dialect reading (POSIX and PowerShell), so the caller fails closed.
   */
  unresolved: boolean;
}

/**
 * Directories a shell command moves to or points git at, used only to decide whether a publish
 * command run outside a loop cwd still acts on a PR Genie loop worktree. Modelled: `cd` (and
 * `cd /d`, `builtin cd`, `command cd`), `chdir`, `pushd`, `Set-Location` / `sl` / `Push-Location`
 * (`-Path`, `-LiteralPath`; value parameters such as `-StackName` skipped); `git -C` (chained
 * cumulatively, as git does), `--git-dir` / `--work-tree`; `GIT_DIR=` / `GIT_WORK_TREE=` and
 * `$env:GIT_DIR=` / `$env:GIT_WORK_TREE=`; `env -C` / `--chdir`; `sudo -D` / `--chdir`;
 * `Start-Process -WorkingDirectory`; cmd `start /d`.
 *
 * Shell contexts: a `cd` inside a POSIX `( … )` subshell, a `$( … )` substitution, a `for` /
 * `while` / `until` body (`do … done`), a PowerShell `{ … }` scriptblock or a nested shell script
 * does not carry to commands after it; a brace group `{ …; }` does. Relative paths resolve against
 * every directory the context may be in. A run-time target (`cd $d`, `git -C "$PWD"`), `CDPATH`, a
 * bare `cd` / `cd ~` / `cd -` when `HOME` / `OLDPWD` is assigned, or `find -execdir` / `-okdir`
 * makes the context's directory unknown; that only matters when a `git` / `gh` command runs in it.
 */
export function shellCommandPathScan(command: string, cwd: string): PathScan {
  const cdpath = /CDPATH/i.test(command);
  const homeTainted = /(?:^|[^\w$])(?:HOME|OLDPWD)\s*=|\$env:(?:HOME|OLDPWD)\b/i.test(command);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const out = new Set<string>();
  let allUnresolved = true;
  /**
   * A loop list this dialect reading could not read (brace expansion past its bound, `$(…)` or
   * backticks) reached git / gh: fail closed even if the other reading tokenizes it differently.
   */
  let listUnresolved = false;
  let overBound = false;
  for (const events of shellEventPasses(command)) {
    let work = 0;
    let unresolved = false;
    let loopListRunTime = false;
    /**
     * `bases`: directories the context may be in. A `cd` moves every base (it usually succeeds);
     * the context's starting directories stay in the set in case every earlier `cd` failed. That
     * keeps the set linear in the number of `cd`s.
     */
    type Ctx = {
      bases: Set<string>;
      origin: string[];
      unknown: boolean;
      tag: "(" | "do" | "top";
      /** Loop-variable `cd` candidates that stay in effect after `done` (not a subshell). */
      carry: Set<string>;
      /** A loop-variable `cd` whose list could not be read: the directory after `done` is unknown. */
      carryUnknown: boolean;
      /** State before the last loop-variable `cd`; a `cd -` / `popd` straight after restores it. */
      restore: { bases: Set<string>; unknown: boolean; carry: Set<string> } | null;
    };
    let ctx: Ctx = {
      bases: new Set([cwd]),
      origin: [cwd],
      unknown: false,
      tag: "top",
      carry: new Set(),
      carryUnknown: false,
      restore: null,
    };
    /** `for d in a b` / `foreach ($d in a, b)` lists, by variable name. */
    const loopLists = new Map<string, string[]>();
    let pendingForeach: string | null = null;
    const loopVariableItems = (word: string): string[] | null => {
      const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(stripRunTimeMarkers(word));
      return m ? (loopLists.get(m[1]) ?? null) : null;
    };
    const stack: Ctx[] = [];
    const resolveAll = (raw: string, from: Iterable<string>): string[] | null => {
      if (raw === "" || isUnresolvedToken(raw)) return null;
      const expanded = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
      if (path.isAbsolute(expanded)) {
        work++;
        return [path.resolve(expanded)];
      }
      const res = new Set<string>();
      for (const base of from) {
        res.add(path.resolve(base, expanded));
        if (++work > PATH_TARGET_WORK_LIMIT) return null;
      }
      return [...res];
    };
    const record = (dirs: string[]): void => {
      for (const d of dirs) {
        out.add(d);
        // `--git-dir=<repo>/.git`: the repo (and its steward state) is the parent.
        if (path.basename(d) === ".git") out.add(path.dirname(d));
      }
    };
    const open = (tag: "(" | "do"): void => {
      work += ctx.bases.size;
      stack.push(ctx);
      ctx = {
        bases: new Set(ctx.bases),
        origin: [...ctx.bases],
        unknown: ctx.unknown,
        tag,
        carry: new Set(),
        carryUnknown: false,
        restore: null,
      };
    };
    const close = (tag: "(" | "do"): void => {
      while (stack.length > 0) {
        const closed = ctx;
        ctx = stack.pop() as Ctx;
        if (closed.tag === "do") {
          if (closed.carryUnknown) {
            ctx.unknown = true;
            if (ctx.tag === "do") ctx.carryUnknown = true;
          }
          for (const d of closed.carry) {
            ctx.bases.add(d);
            // Nested loops: the candidates keep carrying past the outer `done`.
            if (ctx.tag === "do") ctx.carry.add(d);
          }
        }
        if (closed.tag === tag) return;
      }
    };
    for (const ev of events) {
      if (ev === "(" || ev === ")") {
        if (ev === "(") open("(");
        else close("(");
        continue;
      }
      let words = ev;
      if (words[0] === "done") {
        close("do");
        words = words.slice(1);
      }
      if (words[0] === "do") {
        open("do");
        // `do for d in …` (nested loop): read the rest as its own command.
        if (words[1] === "for") words = words.slice(1);
      }
      if (words.length === 0) continue;
      // Loop lists: POSIX `for d in a b`, PowerShell `foreach ($d in a, b)` / `@(a, b)`.
      if (words[0] === "for" && words[2] === "in" && /^[A-Za-z_]\w*$/.test(words[1] ?? "")) {
        loopLists.set(words[1], words.slice(3));
      } else if (/^\$[A-Za-z_]\w*$/.test(stripRunTimeMarkers(words[0])) && words[1] === "in") {
        const name = stripRunTimeMarkers(words[0]).slice(1);
        const items = words.slice(2).filter((w) => w !== "@" && w !== SUBSTITUTION);
        loopLists.set(name, items);
        // `@( … )`: the items are the next simple command.
        pendingForeach = items.length === 0 ? name : null;
      } else if (pendingForeach) {
        loopLists.set(pendingForeach, words);
        pendingForeach = null;
      }
      const sensitive = words.some((_, i) => isGitWord(words, i) || isGhWord(words, i));
      /** A target only for this command (git -C, inline GIT_DIR=, env -C, -WorkingDirectory). */
      let localUnknown = false;
      const addLocal = (raw: string): void => {
        const dirs = resolveAll(raw, ctx.bases);
        if (dirs) record(dirs);
        else localUnknown = true;
      };
      const onlyAssignments = words.every((w) =>
        /^(?:\$env:)?[A-Za-z_][\w:]*\s*=|^=/.test(stripRunTimeMarkers(w)),
      );
      for (let k = 0; k < words.length; k++) {
        // Strip the tokenizer's run-time markers so `$env:GIT_DIR=…` is seen as an assignment.
        const w = stripRunTimeMarkers(words[k]);
        if (/^-(?:exec|ok)dir$/.test(w)) localUnknown = true;
        const m = /^(?:\$env:)?(GIT_DIR|GIT_WORK_TREE)(=?)(.*)$/i.exec(w);
        if (m && (w.startsWith("$") || m[2] === "=")) {
          if (!w.startsWith("$") && !/^(GIT_DIR|GIT_WORK_TREE)$/.test(m[1])) continue;
          let value = m[3];
          if (m[2] === "" && words[k + 1] === "=") value = words[k + 2] ?? "";
          else if (m[2] === "" && words[k + 1]?.startsWith("=")) value = words[k + 1].slice(1);
          else if (m[2] === "=" && value === "") value = words[k + 1] ?? "";
          const dirs = resolveAll(value, ctx.bases);
          if (dirs) record(dirs);
          // `$env:GIT_DIR=$x` (or a bare `GIT_DIR=$x`) persists for later commands.
          else if (w.startsWith("$") || onlyAssignments) ctx.unknown = true;
          else localUnknown = true;
        }
      }
      let head = commandHeadIndex(words);
      // Prefix chdir options: `env -C dir`, `env --chdir=dir`, `sudo -D dir`, `sudo --chdir=dir`.
      for (let k = 0; k < head; k++) {
        const name = commandBasename(words[k]);
        if (name !== "env" && name !== "sudo") continue;
        const short = name === "env" ? "-C" : "-D";
        for (let j = k + 1; j < head && words[j].startsWith("-"); j++) {
          const w = words[j];
          let v: string | undefined;
          if (w === short || w === "--chdir") v = words[++j];
          else if (w.startsWith("--chdir=")) v = w.slice("--chdir=".length);
          else if (w.startsWith(short) && w.length > 2) v = w.slice(2);
          if (v !== undefined) addLocal(v);
        }
      }
      while (head < words.length && CD_LEADING_WORDS.has(commandBasename(words[head]))) {
        if (commandBasename(words[head]) === "command" && /^-[vV]$/.test(words[head + 1] ?? "")) {
          break; // `command -v cd` only looks it up
        }
        head++;
        while (commandBasename(words[head - 1]) === "command" && /^-p$/.test(words[head] ?? "")) {
          head++;
        }
      }
      const name = commandBasename(words[head] ?? "");
      if ((name === "popd" || name === "pop-location") && ctx.restore && !homeTainted) {
        // `pushd $d; …; popd` in a loop body: back where the body started.
        ctx.bases = ctx.restore.bases;
        ctx.unknown = ctx.restore.unknown;
        ctx.carry = ctx.restore.carry;
        ctx.carryUnknown = false;
        ctx.restore = null;
      }
      if (CD_COMMANDS.has(name)) {
        const ps = name.includes("-") || name === "sl";
        let target: string | undefined;
        let dash = false;
        for (let k = head + 1; k < words.length; k++) {
          const w = words[k];
          if (/^\/d$/i.test(w) && (name === "cd" || name === "chdir")) continue; // cmd `cd /d X`
          if (w === "-") {
            dash = true;
            break;
          }
          if (w === "--") {
            target = words[k + 1];
            break;
          }
          if (/^-/.test(w)) {
            if (!ps) continue; // POSIX `cd -P` / `-L` / `-e`
            const colon = w.indexOf(":");
            const kind = locationParamKind(w);
            if (kind === "switch") continue;
            const value = colon >= 0 ? w.slice(colon + 1) : words[++k];
            if (kind === "path") {
              target = value;
              break;
            }
            continue;
          }
          target = w;
          break;
        }
        const toHome = target === undefined && !dash && !ps;
        const back = dash && !cdpath && !homeTainted;
        const restore = ctx.restore;
        ctx.restore = null;
        if (back && restore) {
          // `cd $d; …; cd -` in a loop body: back where the body started.
          ctx.bases = restore.bases;
          ctx.unknown = restore.unknown;
          ctx.carry = restore.carry;
          ctx.carryUnknown = false;
        } else if (cdpath || (homeTainted && (dash || toHome || target?.startsWith("~")))) {
          ctx.unknown = true;
        } else if (toHome) {
          if (home) ctx.bases = new Set([path.resolve(home), ...ctx.origin]);
        } else if (target !== undefined && loopVariableItems(target) !== null) {
          // `for d in <list>; do cd $d; done`: each list word is a candidate target, and the cd
          // carries past `done` (the body is not a subshell).
          const items = loopVariableItems(target) as string[];
          const saved = { bases: ctx.bases, unknown: ctx.unknown, carry: new Set(ctx.carry) };
          const cands: string[] = [];
          let runTime = false;
          const words: string[] = [];
          for (const item of items) {
            const expanded = expandBraces(
              item.replace(/,$/, ""),
              () => ++work > PATH_TARGET_WORK_LIMIT,
            );
            if (!expanded) {
              runTime = true;
              break;
            }
            words.push(...expanded);
          }
          for (const word of words) {
            if (word === "") continue;
            const dirs = /[*?[]/.test(word)
              ? expandGlob(word, ctx.bases, () => ++work > PATH_TARGET_WORK_LIMIT)
              : resolveAll(word, ctx.bases);
            if (!dirs) runTime = true;
            else cands.push(...dirs);
          }
          record(cands);
          if (runTime) {
            loopListRunTime = true;
            ctx.unknown = true;
            ctx.carryUnknown = true;
          }
          ctx.bases = new Set([...cands, ...ctx.origin]);
          for (const d of cands) ctx.carry.add(d);
          ctx.restore = saved;
        } else if (target !== undefined) {
          const dirs = resolveAll(target, ctx.bases);
          if (!dirs) ctx.unknown = true;
          else {
            record(dirs);
            ctx.bases = new Set([...dirs, ...ctx.origin]);
          }
        }
      }
      if (START_PROCESS_COMMANDS.has(name)) {
        for (let k = head + 1; k < words.length; k++) {
          const w = words[k];
          if (name === "start" && /^\/d$/i.test(w)) {
            addLocal(words[k + 1] ?? "");
            k++;
          } else if (name === "start" && /^\/d./i.test(w)) {
            addLocal(w.slice(2));
          } else if (isStartProcessWorkingDirectory(w)) {
            const colon = w.indexOf(":");
            addLocal((colon >= 0 ? w.slice(colon + 1) : words[++k]) ?? "");
          }
        }
      }
      for (let k = 0; k < words.length; k++) {
        if (commandBasename(words[k]) !== "git") continue;
        let gitCwds: string[] = [...ctx.bases];
        for (let j = k + 1; j < words.length && words[j].startsWith("-"); j++) {
          const w = words[j];
          const eq = /^--(?:git-dir|work-tree)=(.*)$/.exec(w);
          let v: string | undefined;
          if (eq) v = eq[1];
          else if (w === "--git-dir" || w === "--work-tree") v = words[++j];
          else if (w === "-C") {
            const next = resolveAll(words[++j] ?? "", gitCwds);
            if (!next) {
              localUnknown = true;
              break;
            }
            gitCwds = next;
            record(next);
            continue;
          } else if (w === "-c" && /^core\.worktree=/i.test(words[j + 1] ?? "")) {
            v = (words[++j] ?? "").replace(/^core\.worktree=/i, "");
          } else if (GIT_GLOBAL_VALUE_FLAGS.has(w)) {
            j++;
            continue;
          } else continue;
          const dirs = resolveAll(v ?? "", gitCwds);
          if (dirs) record(dirs);
          else localUnknown = true;
        }
      }
      if (sensitive && (ctx.unknown || localUnknown)) {
        unresolved = true;
        if (ctx.unknown && loopListRunTime) listUnresolved = true;
      }
      if (
        out.size > PATH_TARGET_LIMIT ||
        ctx.bases.size > PATH_TARGET_BASES_LIMIT ||
        work > PATH_TARGET_WORK_LIMIT
      ) {
        unresolved = true;
        overBound = true;
        break;
      }
    }
    if (!unresolved) allUnresolved = false;
  }
  return { targets: [...out], unresolved: allUnresolved || listUnresolved, overBound };
}

/** {@link shellCommandPathScan} as a list, or `"unresolved"` when the scan fails closed. */
export function shellCommandPathTargets(command: string, cwd: string): string[] | "unresolved" {
  const scan = shellCommandPathScan(command, cwd);
  return scan.unresolved ? "unresolved" : scan.targets;
}

/**
 * Worktree path for a `<repo>/.git/worktrees/<name>` admin dir (from its `gitdir` file), or null.
 * Lets `git --git-dir=<repo>/.git/worktrees/lp-… push` count as acting in that worktree.
 */
export function worktreeForGitAdminDir(dir: string): string | null {
  const parts = path.resolve(dir).split(path.sep);
  const at = parts.lastIndexOf("worktrees");
  if (at < 1 || parts[at - 1] !== ".git" || at + 1 >= parts.length) return null;
  const admin = parts.slice(0, at + 2).join(path.sep) || path.sep;
  try {
    const gitdir = readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    if (gitdir) return path.dirname(path.resolve(admin, gitdir));
  } catch {
    /* no gitdir file: fall back to the name */
  }
  const id = parts[at + 1];
  const repo = parts.slice(0, at - 1).join(path.sep) || path.sep;
  return path.join(`${repo}.loops`, id);
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
