import { git, gitText } from "./git.js";
import { localBaseRef, refsAreSameBranch } from "./worktrees.js";

export type DeclaredBasePr = {
  id: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
};

export type DeclaredBaseAlignment = {
  ok: true;
  mergeBase: string;
  baseTip: string;
};

export type DeclaredBaseMisalignment = {
  ok: false;
  message: string;
  mergeBase: string | null;
  baseTip: string | null;
  /** Intermediate branch tip that makes ahead-of-base look stacked (RAD-94 policy). */
  stackedOn: string | null;
};

export type DeclaredBaseResult = DeclaredBaseAlignment | DeclaredBaseMisalignment;

/** Remote tracking ref that first push/export must set (never the base branch). */
export function exportUpstreamRef(headRef: string): string {
  return `origin/${localBaseRef(headRef)}`;
}

/**
 * Args for the export push. Source is the recorded SHA (not cwd HEAD).
 * Upstream is set separately via {@link ensureExportUpstream} so `-u` cannot
 * attach the current checkout to the declared base by mistake (RAD-94).
 */
export function exportPushArgs(pr: { headSha: string; headRef: string }): string[] {
  return ["push", "origin", `${pr.headSha}:refs/heads/${localBaseRef(pr.headRef)}`];
}

/**
 * Point `headRef` at `origin/<headRef>` after a successful first push.
 * Safe to call when the remote ref already exists; does not touch the base branch.
 */
export async function ensureExportUpstream(cwd: string, headRef: string): Promise<void> {
  const local = localBaseRef(headRef);
  const upstream = exportUpstreamRef(local);
  const result = await git(cwd, ["branch", `--set-upstream-to=${upstream}`, local], {
    allowFail: true,
  });
  if (result.code !== 0) {
    throw new Error(
      `Pushed ${local}, but could not set upstream to ${upstream}: ${result.stderr.trim() || result.stdout.trim() || "git branch --set-upstream-to failed"}`,
    );
  }
}

async function isAncestor(cwd: string, maybeAncestor: string, rev: string): Promise<boolean> {
  const result = await git(cwd, ["merge-base", "--is-ancestor", maybeAncestor, rev], {
    allowFail: true,
  });
  return result.code === 0;
}

async function listLocalHeadBranches(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    allowFail: true,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean);
}

/**
 * Policy (RAD-94): ahead-of-base must not include commits that only exist because
 * this head is stacked on another local branch tip (strict ancestor of head, not
 * an ancestor of the declared base tip).
 *
 * RAD-87 seam: when that parent looks like another loop head (`lp-*`), the error
 * points at dependsOn / base = other loop head — full dependsOn UX is out of scope.
 */
export async function findStackedParentBranch(
  cwd: string,
  pr: Pick<DeclaredBasePr, "headRef" | "headSha" | "baseRef">,
  baseTip: string,
): Promise<string | null> {
  const head = localBaseRef(pr.headRef);
  const base = localBaseRef(pr.baseRef);
  const branches = await listLocalHeadBranches(cwd);
  for (const name of branches) {
    if (refsAreSameBranch(name, head) || refsAreSameBranch(name, base)) continue;
    let tip: string;
    try {
      tip = await gitText(cwd, ["rev-parse", "--verify", name]);
    } catch {
      continue;
    }
    if (tip === pr.headSha) continue; // alias of head tip, not an intermediate stack parent
    if (!(await isAncestor(cwd, tip, pr.headSha))) continue;
    if (await isAncestor(cwd, tip, baseTip)) continue; // already on the declared base history
    return name;
  }
  return null;
}

/**
 * Verify the loop head is based on the tip of the declared `baseRef`, and that
 * ahead-of-base does not include unrelated stacked commits (RAD-94).
 */
export async function checkDeclaredBaseAlignment(
  cwd: string,
  pr: DeclaredBasePr,
): Promise<DeclaredBaseResult> {
  const base = localBaseRef(pr.baseRef);
  const baseResolved = await git(cwd, ["rev-parse", "--verify", base], { allowFail: true });
  if (baseResolved.code !== 0) {
    return {
      ok: false,
      message: `Cannot resolve declared baseRef "${pr.baseRef}" for loop ${pr.id}.`,
      mergeBase: null,
      baseTip: null,
      stackedOn: null,
    };
  }
  const baseTip = baseResolved.stdout.trim();
  const mb = await git(cwd, ["merge-base", pr.headSha, baseTip], { allowFail: true });
  if (mb.code !== 0) {
    return {
      ok: false,
      message: `Cannot compute merge-base of ${pr.headRef} and declared base ${base} for loop ${pr.id}.`,
      mergeBase: null,
      baseTip,
      stackedOn: null,
    };
  }
  const mergeBase = mb.stdout.trim();
  if (mergeBase !== baseTip) {
    return {
      ok: false,
      message:
        `Loop ${pr.id} declared base ${base}, but merge-base (${mergeBase.slice(0, 8)}) ` +
        `≠ tip of ${base} (${baseTip.slice(0, 8)}). Rebase ${pr.headRef} onto ${base}, ` +
        `or set baseRef to the real parent branch.`,
      mergeBase,
      baseTip,
      stackedOn: null,
    };
  }

  const stackedOn = await findStackedParentBranch(cwd, pr, baseTip);
  if (stackedOn) {
    const loopParent = /^lp-[0-9a-f]{8}$/i.test(localBaseRef(stackedOn));
    const rad87 = loopParent
      ? ` This looks like another loop head — RAD-87 dependsOn / base = other loop head will model that; until then set baseRef to ${stackedOn} or rebase onto ${base}.`
      : ` Set baseRef to ${stackedOn} (or rebase onto ${base}). Stacked bases are coordinated with RAD-87 dependsOn (not implemented here).`;
    return {
      ok: false,
      message:
        `Loop ${pr.id} declared base ${base}, but ${pr.headRef} is stacked on ${stackedOn} ` +
        `(ahead-of-base includes unrelated commits vs policy).${rad87}`,
      mergeBase,
      baseTip,
      stackedOn,
    };
  }

  return { ok: true, mergeBase, baseTip };
}

/** Throw when declared base alignment fails (ready / run_ci / export). */
export async function assertDeclaredBaseAligned(cwd: string, pr: DeclaredBasePr): Promise<void> {
  const result = await checkDeclaredBaseAlignment(cwd, pr);
  if (!result.ok) throw new Error(result.message);
}
