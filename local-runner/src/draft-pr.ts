import type { CiStatusInfo, JobRecord, JobStage } from "./types.js";
import { isCiFinal } from "./ci.js";
import { gh, git } from "./github.js";
import { repoSlugFromPrUrl } from "./ci.js";

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
  if (ci !== "success") {
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
  target: { prNumber?: number | null; branch?: string; prUrl?: string | null },
  ghImpl: typeof gh = gh,
): Promise<PrViewInfo | null> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) return null;
  const args = ["pr", "view", ref, "--json", "isDraft,headRefOid,state"];
  const slug = repoSlugFromPrUrl(target.prUrl);
  if (slug) args.push("--repo", slug);
  const res = await ghImpl(cwd, args);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      isDraft?: boolean;
      headRefOid?: string;
      state?: string;
    };
    return {
      isDraft: Boolean(parsed.isDraft),
      headRefOid: parsed.headRefOid?.trim() || null,
      state: parsed.state ?? null,
    };
  } catch {
    return null;
  }
}

export async function promotePrToReady(
  cwd: string,
  target: { prNumber?: number | null; branch?: string; prUrl?: string | null },
  ghImpl: typeof gh = gh,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) return { ok: false, error: "no PR ref" };
  const args = ["pr", "ready", ref];
  const slug = repoSlugFromPrUrl(target.prUrl);
  if (slug) args.push("--repo", slug);
  const res = await ghImpl(cwd, args);
  if (res.code === 0) return { ok: true };
  const err = res.stderr.trim() || res.stdout.trim() || "gh pr ready failed";
  if (/already/i.test(err)) return { ok: true };
  return { ok: false, error: err.slice(0, 400) };
}

export type PromoteDeps = {
  gh?: typeof gh;
  git?: typeof git;
  now?: () => string;
};

/** Sync isDraft from GitHub and promote draft→ready when policy matches. */
export async function syncDraftReadyForJob(
  job: JobRecord,
  cwd: string | null,
  deps: PromoteDeps = {},
): Promise<{ job: JobRecord; changed: boolean }> {
  if (!cwd?.trim() || (job.prNumber == null && !job.input.branch)) {
    return { job, changed: false };
  }
  const ghImpl = deps.gh ?? gh;
  const gitImpl = deps.git ?? git;
  const now = deps.now ?? (() => new Date().toISOString());

  let changed = false;
  const view = await fetchPrViewInfo(
    cwd,
    { prNumber: job.prNumber, branch: job.input.branch, prUrl: job.prUrl },
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
  });

  if (decision.action === "already_ready" && !job.readyPromotedAt) {
    job.readyPromotedAt = now();
    changed = true;
  }

  if (decision.action === "promote") {
    const result = await promotePrToReady(
      cwd,
      { prNumber: job.prNumber, branch: job.input.branch, prUrl: job.prUrl },
      ghImpl,
    );
    if (result.ok) {
      job.readyPromotedAt = now();
      job.prIsDraft = false;
      changed = true;
    } else {
      const note = `pr ready: ${result.error}`;
      job.error = job.error ? `${job.error}; ${note}` : note;
      changed = true;
    }
  }

  return { job, changed };
}
