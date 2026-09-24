import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireGitRoot } from "./git.js";
import { getLocalPr, isArchivedPr, listLocalPrs } from "./prs.js";
import { consoleDir, parseJsonObject, withFileLock, writeJsonFile } from "./store.js";

export interface ReviewClaim {
  id: string;
  headSha: string;
  claimedAt: string;
  source: string;
}

export type ClaimReviewReason = "already_claimed" | "not_ready" | "head_mismatch";

export interface ClaimReviewResult {
  claimed: boolean;
  id: string;
  claim: ReviewClaim | null;
  reason?: ClaimReviewReason;
  status?: string;
}

interface ReviewClaimsState {
  updatedAt: string;
  claims: Record<string, ReviewClaim>;
}

function claimsFile(dir: string): string {
  return path.join(dir, "review-claims.json");
}

export function reviewClaimKey(id: string, headSha: string): string {
  return `${id}:${headSha}`;
}

const emptyClaims = (): ReviewClaimsState => ({
  updatedAt: new Date(0).toISOString(),
  claims: {},
});

function parseClaims(raw: string): ReviewClaimsState {
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  const updatedAt =
    typeof parsed.updatedAt === "string" ? parsed.updatedAt : emptyClaims().updatedAt;
  const claims: Record<string, ReviewClaim> = {};
  const rawClaims = parsed.claims;
  if (rawClaims && typeof rawClaims === "object" && !Array.isArray(rawClaims)) {
    for (const [key, value] of Object.entries(rawClaims as Record<string, unknown>)) {
      const claim = parseClaim(value);
      if (claim) claims[key] = claim;
    }
  }
  return { updatedAt, claims };
}

function parseClaim(raw: unknown): ReviewClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed.id !== "string" || typeof parsed.headSha !== "string") return null;
  return {
    id: parsed.id,
    headSha: parsed.headSha,
    claimedAt: typeof parsed.claimedAt === "string" ? parsed.claimedAt : new Date(0).toISOString(),
    source: typeof parsed.source === "string" ? parsed.source : "cli",
  };
}

async function pruneStale(cwd: string, state: ReviewClaimsState): Promise<ReviewClaimsState> {
  const live = (await listLocalPrs(cwd)).filter((pr) => !isArchivedPr(pr));
  const byId = new Map(live.map((pr) => [pr.id, pr]));
  const claims: Record<string, ReviewClaim> = {};
  for (const claim of Object.values(state.claims)) {
    const pr = byId.get(claim.id);
    if (
      !pr ||
      (pr.status !== "ready" && pr.status !== "review_interrupted") ||
      pr.headSha !== claim.headSha
    )
      continue;
    claims[reviewClaimKey(claim.id, claim.headSha)] = claim;
  }
  return { updatedAt: state.updatedAt, claims };
}

async function loadClaims(file: string): Promise<ReviewClaimsState> {
  try {
    return parseClaims(await readFile(file, "utf8"));
  } catch {
    return emptyClaims();
  }
}

/**
 * Exclusive in-flight reviewer lock for `(id, headSha)`.
 * Stale rows (not ready, archived, or HEAD moved) are dropped.
 */
export async function claimReview(
  cwd: string,
  id: string,
  options: { headSha?: string; source?: string } = {},
): Promise<ClaimReviewResult> {
  const root = await requireGitRoot(cwd);
  const file = claimsFile(await consoleDir(root));
  return withFileLock(file, async () => {
    const pr = await getLocalPr(root, id);
    if (pr.status !== "ready" && pr.status !== "review_interrupted") {
      return {
        claimed: false,
        id: pr.id,
        claim: null,
        reason: "not_ready" as const,
        status: pr.status,
      };
    }
    if (options.headSha && options.headSha !== pr.headSha) {
      return {
        claimed: false,
        id: pr.id,
        claim: null,
        reason: "head_mismatch" as const,
        status: pr.status,
      };
    }
    const headSha = options.headSha ?? pr.headSha;
    const current = await pruneStale(root, await loadClaims(file));
    const existing = current.claims[reviewClaimKey(pr.id, headSha)];
    if (existing) {
      await writeJsonFile(file, current);
      return {
        claimed: false,
        id: pr.id,
        claim: existing,
        reason: "already_claimed" as const,
        status: pr.status,
      };
    }
    const claim: ReviewClaim = {
      id: pr.id,
      headSha,
      claimedAt: new Date().toISOString(),
      source: options.source ?? "cli",
    };
    current.claims[reviewClaimKey(pr.id, headSha)] = claim;
    current.updatedAt = claim.claimedAt;
    await writeJsonFile(file, current);
    return { claimed: true, id: pr.id, claim, status: pr.status };
  });
}

export async function listReviewClaims(cwd: string): Promise<ReviewClaim[]> {
  const root = await requireGitRoot(cwd);
  const file = claimsFile(await consoleDir(root));
  return withFileLock(file, async () => {
    const current = await pruneStale(root, await loadClaims(file));
    await writeJsonFile(file, current);
    return Object.values(current.claims);
  });
}

export async function getReviewClaim(
  cwd: string,
  id: string,
  headSha: string,
): Promise<ReviewClaim | null> {
  const claims = await listReviewClaims(cwd);
  return claims.find((c) => c.id === id && c.headSha === headSha) ?? null;
}

export function formatClaimReview(result: ClaimReviewResult): string {
  if (result.claimed && result.claim) {
    return `claimed  ${result.claim.id}  ${result.claim.headSha}`;
  }
  if (result.reason === "already_claimed" && result.claim) {
    return `already_claimed  ${result.claim.id}  ${result.claim.headSha}  claimedAt=${result.claim.claimedAt}`;
  }
  if (result.reason === "not_ready") {
    return `not_ready  ${result.id}  status=${result.status ?? "unknown"}`;
  }
  if (result.reason === "head_mismatch") {
    return `head_mismatch  ${result.id}`;
  }
  return `claim_failed  ${result.id}`;
}
