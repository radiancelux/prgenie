import type { CiStatusInfo, JobRecord, JobStage } from "./types.js";
import { isCiFinal } from "./ci.js";
import { isDocsJob } from "./doc-checks.js";
import { ghRaw, git } from "./github.js";
import { resolveRepoSlug, restGetPull, restMarkPullReady } from "./github-rest.js";

export type PrViewInfo = {
  isDraft: boolean;
  headRefOid: string | null;
  state: string | null;
};

export type DraftReadyDecision =
  { action: "none" } | { action: "promote" } | { action: "already_ready" };

export type DraftReadyState = {
  stage: JobStage;
  lastVerdict: JobRecord["lastVerdict"];
  ciStatus: CiStatusInfo | null;
  approveHeadSha: string | null;
  currentHeadSha: string | null;
  isDraft: boolean | null;
  readyPromotedAt: string | null;
  docsJob?: boolean;
};

/** Pure decision for unit tests — when to run \`gh pr ready\`. */
export function decideDraftReadyPromotion(state: DraftReadyState): DraftReadyDecision {
  if (state.readyPromotedAt) {
    return state.isDraft === false ? { action: "already_ready" } : { action: "none" };
  }
  if (state.stage !== "approved" || state.lastVerdict !== "APPROVE") {
    return { action: "none" };
  }
  if (state.isDraft === false) {
    return { action: "already_ready" };
  }
  if (state.isDraft !== true) {
    return { action: "none" };
  }
  const ci = state.ciStatus?.status;
  const checksOk = state.docsJob ? ci === "success" || ci === "neutral" : ci === "success";
  if (!checksOk) {
    return { action: "none" };
  }
  if (!state.approveHeadSha || !state.currentHeadSha) {
    return { action: "none" };
  }
  if (state.approveHeadSha !== state.currentHeadSha) {
    return { action: "none" };
  }
  return { action: "promote" };
}

export async function readHeadSha(cwd: string): Promise<string | null> {
  const res = await git(cwd, ["rev-parse", "HEAD"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

export async function fetchPrViewInfo(
  cwd: string,
  target: {
    prNumber?: number | null;
    branch?: string;
    prUrl?: string | null;
    repoSlug?: string | null;
  },
  ghImpl: typeof ghRaw = ghRaw,
): Promise<PrViewInfo | null> {
  if (target.prNumber == null) return null;
  const slug = resolveRepoSlug(target.repoSlug ?? null, target.prUrl);
  const pull = await restGetPull(cwd, target.prNumber, slug, ghImpl);
  if (!pull) return null;
  return {
    isDraft: Boolean(pull.draft),
    headRefOid: pull.head?.sha?.trim() || null,
    state: pull.state?.toUpperCase() ?? null,
  };
}

export async function promotePrToReady(
  cwd: string,
  target: {
    prNumber?: number | null;
    branch?: string;
    prUrl?: string | null;
    repoSlug?: string | null;
  },
  ghImpl: typeof ghRaw = ghRaw,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (target.prNumber == null) return { ok: false, error: "no PR ref" };
  const slug = resolveRepoSlug(target.repoSlug ?? null, target.prUrl);
  return restMarkPullReady(cwd, target.prNumber, slug, ghImpl);
}

export type PromoteDeps = {
  gh?: typeof ghRaw;
  git?: typeof git;
  now?: () => string;
};

/** Sync isDraft from GitHub and promote draft→ready when policy matches. */
export async function syncDraftReadyForJob(
  job: JobRecord,
  cwd: string | null,
  deps: PromoteDeps = {},
): Promise<{ job: JobRecord; changed: boolean; errorNote?: string }> {
  if (!cwd?.trim() || (job.prNumber == null && !job.input.branch)) {
    return { job, changed: false };
  }
  const ghImpl = deps.gh ?? ghRaw;
  const gitImpl = deps.git ?? git;
  const now = deps.now ?? (() => new Date().toISOString());

  let changed = false;
  let errorNote: string | undefined;
  const view = await fetchPrViewInfo(
    cwd,
    {
      prNumber: job.prNumber,
      branch: job.input.branch,
      prUrl: job.prUrl,
      repoSlug: job.repoSlug,
    },
    ghImpl,
  );
  if (view) {
    if (job.prIsDraft !== view.isDraft) {
      job.prIsDraft = view.isDraft;
      changed = true;
    }
  }

  const currentHeadSha = view?.headRefOid ?? (await readHeadSha(cwd));
  const decision = decideDraftReadyPromotion({
    stage: job.stage,
    lastVerdict: job.lastVerdict,
    ciStatus: job.ciStatus,
    approveHeadSha: job.approveHeadSha,
    currentHeadSha,
    isDraft: job.prIsDraft,
    readyPromotedAt: job.readyPromotedAt,
    docsJob: isDocsJob(job),
  });

  if (decision.action === "already_ready" && !job.readyPromotedAt) {
    job.readyPromotedAt = now();
    changed = true;
  }

  if (decision.action === "promote") {
    const result = await promotePrToReady(
      cwd,
      {
        prNumber: job.prNumber,
        branch: job.input.branch,
        prUrl: job.prUrl,
        repoSlug: job.repoSlug,
      },
      ghImpl,
    );
    if (result.ok) {
      job.readyPromotedAt = now();
      job.prIsDraft = false;
      changed = true;
    } else {
      errorNote = `pr ready: ${result.error}`;
      job.error = job.error ? `${job.error}; ${errorNote}` : errorNote;
      changed = true;
    }
  }

  return { job, changed, errorNote };
}
