import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGitRoot, requireGitRoot } from "./git.js";
import { getRepoGithubBind, listGhAccounts } from "./github-ops.js";
import { isArchivedPr, listCorruptLocalPrFiles, listLocalPrs } from "./prs.js";
import { formatWatchStatus, getRepoWatch } from "./watch.js";
import { listWorktrees, loopWorktreeIdentity, primaryWorktreePath, sameFsPath } from "./worktrees.js";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  summary: string;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

async function hashFile(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

/** Walk up from cwd for a PR Genie monorepo checkout (packages/plugin present). */
function findPackageRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "packages", "plugin", "mcp"))) return dir;
    if (existsSync(path.join(dir, "packages", "plugin", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const root = await findGitRoot(cwd);
  if (!root) {
    return {
      ok: false,
      checks: [
        {
          id: "git",
          ok: false,
          summary: "Not inside a git repository.",
          fix: "cd into a PR Genie checkout.",
        },
      ],
    };
  }
  await requireGitRoot(root);

  const packageRoot = findPackageRoot(root);
  const home = os.homedir();
  const installedPlugin = path.join(home, ".cursor", "plugins", "local", "prgenie");
  const installedMcp = path.join(installedPlugin, "mcp", "server.cjs");
  const sourceMcp = packageRoot
    ? path.join(packageRoot, "packages", "plugin", "mcp", "server.cjs")
    : null;

  const installedHash = await hashFile(installedMcp);
  const sourceHash = sourceMcp ? await hashFile(sourceMcp) : null;
  if (!existsSync(installedPlugin)) {
    checks.push({
      id: "plugin-install",
      ok: false,
      summary: `Cursor plugin not found at ${installedPlugin}.`,
      fix: "From the repo: pnpm build && pnpm link-plugin, then Customize → Plugins → disable/enable PR Genie.",
    });
  } else if (sourceHash && installedHash && sourceHash !== installedHash) {
    checks.push({
      id: "plugin-stale",
      ok: false,
      summary: `Installed MCP server (${installedHash}) differs from repo build (${sourceHash}).`,
      fix: "pnpm build && pnpm link-plugin, then Customize → Plugins → disable/enable PR Genie (reload alone often keeps a stale tool list).",
    });
  } else if (installedHash && sourceHash) {
    checks.push({
      id: "plugin-stale",
      ok: true,
      summary: `Plugin MCP server matches repo build (${sourceHash}).`,
    });
  } else {
    checks.push({
      id: "plugin-stale",
      ok: Boolean(existsSync(installedMcp)),
      summary: existsSync(installedMcp)
        ? "Plugin MCP server is installed (repo build hash unavailable — run doctor from the monorepo)."
        : "Plugin folder exists but mcp/server.cjs is missing — run pnpm build && pnpm link-plugin.",
      fix: existsSync(installedMcp) ? undefined : "pnpm build && pnpm link-plugin",
    });
  }

  const extPkg = packageRoot
    ? path.join(packageRoot, "packages", "extension", "package.json")
    : null;
  const installedExtDirs = [
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".vscode", "extensions"),
  ];
  let extSourceVersion: string | null = null;
  if (extPkg && existsSync(extPkg)) {
    try {
      extSourceVersion = JSON.parse(await readFile(extPkg, "utf8")).version ?? null;
    } catch {
      extSourceVersion = null;
    }
  }
  let foundExt: string | null = null;
  let foundExtVersion: string | null = null;
  for (const dir of installedExtDirs) {
    if (!existsSync(dir)) continue;
    try {
      const names = await readdir(dir);
      const match = names.find((n) => /prgenie/i.test(n));
      if (!match) continue;
      foundExt = path.join(dir, match);
      try {
        const pkg = JSON.parse(await readFile(path.join(foundExt, "package.json"), "utf8"));
        foundExtVersion = typeof pkg.version === "string" ? pkg.version : null;
      } catch {
        foundExtVersion = null;
      }
      break;
    } catch {
      // ignore
    }
  }
  if (!foundExt) {
    checks.push({
      id: "extension",
      ok: false,
      summary: "Local PRs extension not found under ~/.cursor/extensions.",
      fix: "pnpm build && pnpm link-extension, then quit Cursor fully and reopen.",
    });
  } else if (extSourceVersion && foundExtVersion && extSourceVersion !== foundExtVersion) {
    checks.push({
      id: "extension",
      ok: false,
      summary: `Extension ${foundExtVersion} is installed; repo source is ${extSourceVersion}.`,
      fix: "pnpm build && pnpm link-extension, then quit Cursor fully and reopen.",
    });
  } else {
    checks.push({
      id: "extension",
      ok: true,
      summary: `Extension installed${foundExtVersion ? ` (${foundExtVersion})` : ""}.`,
    });
  }

  const watch = await getRepoWatch(root);
  checks.push({
    id: "watch",
    ok: true,
    summary: formatWatchStatus(watch).trim().replace(/\n/g, "; "),
  });

  const corrupt = await listCorruptLocalPrFiles(root);
  checks.push({
    id: "corrupt-prs",
    ok: corrupt.length === 0,
    summary:
      corrupt.length === 0
        ? "No unparsable local PR JSON files."
        : `${corrupt.length} unparsable PR file(s): ${corrupt.map((f) => path.basename(f)).join(", ")}`,
    fix:
      corrupt.length === 0
        ? undefined
        : "Inspect or delete the listed files under .git/agent-console/prs/. listLocalPrs skips them silently.",
  });

  const trees = await listWorktrees(root);
  const primary = primaryWorktreePath(trees);
  const liveIds = new Set(
    (await listLocalPrs(root)).filter((pr) => !isArchivedPr(pr)).map((pr) => pr.id.toLowerCase()),
  );
  const orphans: string[] = [];
  for (const tree of trees) {
    const ident = loopWorktreeIdentity(tree.path);
    if (!ident) continue;
    if (primary && sameFsPath(tree.path, primary)) continue;
    if (!liveIds.has(ident.id.toLowerCase())) orphans.push(tree.path);
  }
  checks.push({
    id: "orphan-worktrees",
    ok: orphans.length === 0,
    summary:
      orphans.length === 0
        ? "No orphaned .loops worktrees."
        : `${orphans.length} orphaned loop worktree(s).`,
    fix:
      orphans.length === 0
        ? undefined
        : `Remove with git worktree remove <path> (or reopen/delete the matching loop): ${orphans.join("; ")}`,
  });

  const accounts = await listGhAccounts().catch(() => []);
  const bind = await getRepoGithubBind(root).catch(() => null);
  if (!bind) {
    checks.push({
      id: "gh-bind",
      ok: accounts.length === 0,
      summary:
        accounts.length === 0
          ? "No gh accounts (gh auth login) and this repo is unbound."
          : "This repo is unbound to a gh login.",
      fix: accounts.length
        ? `prgenie gh use <login> (available: ${accounts.map((a) => a.login).join(", ")})`
        : "gh auth login, then prgenie gh use <login>",
    });
  } else {
    checks.push({
      id: "gh-bind",
      ok: true,
      summary: `Bound to ${bind.login} on ${bind.host}.`,
    });
  }

  const legacyGate = packageRoot
    ? path.join(packageRoot, "packages", "plugin", "hooks", "push-gate.mjs")
    : path.join(installedPlugin, "hooks", "push-gate.mjs");
  if (existsSync(legacyGate)) {
    checks.push({
      id: "legacy-push-gate",
      ok: false,
      summary: "Legacy push-gate.mjs is still on disk and is not registered in hooks.json.",
      fix: "Delete packages/plugin/hooks/push-gate.mjs (superseded by github-gate.cjs) and re-run pnpm link-plugin.",
    });
  } else {
    checks.push({
      id: "legacy-push-gate",
      ok: true,
      summary: "No legacy push-gate.mjs.",
    });
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const mark = c.ok ? "ok  " : "FAIL";
    const fix = c.fix && !c.ok ? `\n      fix: ${c.fix}` : "";
    return `  ${mark}  ${c.id} — ${c.summary}${fix}`;
  });
  return `prgenie doctor ${report.ok ? "passed" : "found issues"}\n${lines.join("\n")}\n`;
}
