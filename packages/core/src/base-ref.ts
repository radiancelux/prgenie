import { git, gitText } from "./git.js";
import { localBaseRef, refsAreSameBranch } from "./worktrees.js";

/** True when `ref` looks like a raw commit SHA (not a branch name). */
export function looksLikeCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref.trim());
}

/** Canonical short branch name for storage, display, and duplicate checks (RAD-145 / RAD-149). */
export function normalizeStoredBaseRef(baseRef: string): string {
  return localBaseRef(baseRef);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--verify", ref], { allowFail: true });
  return result.code === 0;
}

/**
 * Whether `baseRef` names an existing local or remote-tracking branch.
 * Returns null for commit SHAs, tags, or other non-branch refs.
 */
export async function classifyBaseRefAsBranch(
  cwd: string,
  baseRef: string,
): Promise<"local" | "remote" | null> {
  const trimmed = baseRef.trim();
  if (!trimmed || looksLikeCommitSha(trimmed)) return null;

  if (trimmed.startsWith("refs/heads/")) {
    return (await refExists(cwd, trimmed)) ? "local" : null;
  }
  if (trimmed.startsWith("refs/remotes/")) {
    return (await refExists(cwd, trimmed)) ? "remote" : null;
  }
  if (trimmed.includes("/")) {
    if (await refExists(cwd, `refs/remotes/${trimmed}`)) return "remote";
    const localAlias = localBaseRef(trimmed);
    if (localAlias !== trimmed && (await refExists(cwd, `refs/heads/${localAlias}`))) {
      return "local";
    }
  }
  if (await refExists(cwd, `refs/heads/${trimmed}`)) return "local";
  // Stored packets are the short name (`main`), including a legacy `origin/main` read.
  // When local `main` is gone, `refs/remotes/origin/main` is still that branch.
  // `upstream/main` is not rewritten — `localBaseRef` only strips `origin/`.
  const short = normalizeStoredBaseRef(trimmed);
  if (short && (await refExists(cwd, `refs/remotes/origin/${short}`))) return "remote";
  return null;
}

/** Remote-tracking branch short names only — excludes origin/HEAD (`origin`) aliases. */
function remoteBranchShortName(name: string): string | null {
  const trimmed = name.replace(/\r$/, "").trim();
  if (!trimmed || trimmed === "origin" || trimmed.endsWith("/HEAD")) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return normalizeStoredBaseRef(trimmed);
}

/** When a SHA matches exactly one remote branch tip, suggest that branch name. */
export async function suggestBranchForSha(cwd: string, sha: string): Promise<string | null> {
  // Prefix, not refs/remotes/*/*: a * glob does not cross /, so origin/feat/foo is omitted.
  const result = await git(
    cwd,
    ["for-each-ref", "refs/remotes", `--points-at=${sha.trim()}`, "--format=%(refname:short)"],
    { allowFail: true },
  );
  if (result.code !== 0) return null;
  const names = [
    ...new Set(
      result.stdout
        .split("\n")
        .map((line) => remoteBranchShortName(line))
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  return names.length === 1 ? names[0]! : null;
}

/** Git ref to resolve the branch tip SHA — keeps remote form when that is the classified base. */
export async function resolveBaseBranchRevParseRef(
  cwd: string,
  rawBaseRef: string,
): Promise<string> {
  const trimmed = rawBaseRef.trim();
  if (trimmed.startsWith("refs/remotes/")) return trimmed;
  if (trimmed.startsWith("refs/heads/")) return trimmed;
  const kind = await classifyBaseRefAsBranch(cwd, trimmed);
  if (kind === "remote") {
    if (await refExists(cwd, `refs/remotes/${trimmed}`)) return `refs/remotes/${trimmed}`;
    return `refs/remotes/origin/${normalizeStoredBaseRef(trimmed)}`;
  }
  if (kind === "local") return `refs/heads/${normalizeStoredBaseRef(trimmed)}`;
  throw new Error(`Cannot resolve base branch ref: ${trimmed}`);
}

/** Normalize stored baseRef and resolve its tip SHA from the classified branch ref. */
export async function resolveStoredBaseBranch(
  cwd: string,
  rawBaseRef: string,
): Promise<{ baseRef: string; baseSha: string }> {
  const baseRef = normalizeStoredBaseRef(rawBaseRef);
  const resolveRef = await resolveBaseBranchRevParseRef(cwd, rawBaseRef);
  const baseResolved = await git(cwd, ["rev-parse", "--verify", resolveRef], { allowFail: true });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  return { baseRef, baseSha: baseResolved.stdout.trim() };
}

export function formatBaseRefNotBranchError(
  baseRef: string,
  options: { suggestedBranch?: string | null; loopId?: string } = {},
): string {
  const prefix = options.loopId ? `Loop ${options.loopId}: ` : "";
  const ref = baseRef.trim();
  if (looksLikeCommitSha(ref)) {
    const hint = options.suggestedBranch ?? "main";
    return `${prefix}\`${ref}\` is a commit; pass the branch name, e.g. \`${hint}\`.`;
  }
  return `${prefix}\`${ref}\` is not a branch name (use a local branch or \`origin/<branch>\`).`;
}

/** Refuse commit SHAs and other non-branch refs at create / ready / CI / export (RAD-145). */
export async function assertBaseRefIsBranch(
  cwd: string,
  baseRef: string,
  options: { loopId?: string } = {},
): Promise<void> {
  const kind = await classifyBaseRefAsBranch(cwd, baseRef);
  if (kind) return;
  const suggested = looksLikeCommitSha(baseRef) ? await suggestBranchForSha(cwd, baseRef) : null;
  throw new Error(formatBaseRefNotBranchError(baseRef, { suggestedBranch: suggested, ...options }));
}

/** Re-validate stored packet `baseRef` before ready / run_ci / export (legacy SHA packets). */
export async function assertStoredBaseRefIsBranch(
  cwd: string,
  pr: { id: string; baseRef: string },
): Promise<void> {
  await assertBaseRefIsBranch(cwd, pr.baseRef, { loopId: pr.id });
}

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
 * Candidate names for stacked-parent detection (RAD-94).
 *
 * Only other **live local-PR headRefs** and `lp-*` loop tips. A WIP bookmark /
 * `git branch` at HEAD~1 on the same first-parent walk has the same ancestry
 * topology as a true linear stack — scanning every local tip false-positives
 * correctly based loops. Arbitrary named feature parents without a live local
 * PR are not flagged (set baseRef correctly, or open a loop for the parent;
 * RAD-87 dependsOn will model explicit stacks).
 */
export async function stackedParentCandidateNames(
  cwd: string,
  pr: Pick<DeclaredBasePr, "id" | "headRef">,
): Promise<string[]> {
  const head = localBaseRef(pr.headRef);
  const names = new Set<string>();
  try {
    const { isArchivedPr, listLocalPrs } = await import("./prs.js");
    for (const other of await listLocalPrs(cwd)) {
      if (other.id === pr.id) continue;
      if (isArchivedPr(other)) continue;
      const otherHead = localBaseRef(other.headRef);
      if (!otherHead || refsAreSameBranch(otherHead, head)) continue;
      names.add(otherHead);
    }
  } catch {
    // No packet store / not a PR Genie repo — fall through to lp-* tips only.
  }
  for (const name of await listLocalHeadBranches(cwd)) {
    const short = localBaseRef(name);
    if (/^lp-[0-9a-f]{8}$/i.test(short) && !refsAreSameBranch(short, head)) {
      names.add(short);
    }
  }
  return [...names];
}

/**
 * Policy (RAD-94): ahead-of-base must not include commits that only exist because
 * this head is stacked on another **loop / live local-PR** tip (strict ancestor
 * of head, not an ancestor of the declared base tip). See
 * {@link stackedParentCandidateNames} for why plain intermediate bookmarks are
 * ignored.
 *
 * RAD-87 seam: when that parent looks like another loop head (`lp-*`), the error
 * points at dependsOn / base = other loop head — full dependsOn UX is out of scope.
 */
export async function findStackedParentBranch(
  cwd: string,
  pr: Pick<DeclaredBasePr, "id" | "headRef" | "headSha" | "baseRef">,
  baseTip: string,
): Promise<string | null> {
  const base = localBaseRef(pr.baseRef);
  const candidates = await stackedParentCandidateNames(cwd, pr);
  for (const name of candidates) {
    if (refsAreSameBranch(name, base)) continue;
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
  let resolveRef: string;
  try {
    resolveRef = await resolveBaseBranchRevParseRef(cwd, pr.baseRef);
  } catch {
    return {
      ok: false,
      message: `Cannot resolve declared baseRef "${pr.baseRef}" for loop ${pr.id}.`,
      mergeBase: null,
      baseTip: null,
      stackedOn: null,
    };
  }
  const baseResolved = await git(cwd, ["rev-parse", "--verify", resolveRef], { allowFail: true });
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
