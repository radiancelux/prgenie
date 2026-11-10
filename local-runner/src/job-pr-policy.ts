import type { JobInput } from "./types.js";

/** Default true: jobs without a GitHub PR after build are stuck unless opted out. */
export function jobExpectsPr(input: Pick<JobInput, "expectPr">): boolean {
  return input.expectPr !== false;
}

export type PostBuildNoPrResolution =
  { kind: "stuck"; error: string } | { kind: "complete"; error: null };

export const NO_PR_GUARD_MESSAGE =
  "No GitHub PR for branch after build (local diff guard). The runner could not commit, push, and open a draft PR. Use continue_job or add git instructions to your prompt.";

export const NO_COMMITS_BEYOND_BASE_MESSAGE =
  "Build finished with no commits on this branch beyond the base (the agent made no changes, or the branch already matched the base). GitHub will not open a pull request with zero commits. Use continue_job with new instructions, or pass expectPr: false if no PR is needed.";

export function isNoCommitsBetweenBasePrError(error: string): boolean {
  return /no commits between/i.test(error);
}

export function resolvePostBuildNoPrError(opts: {
  ensureError?: string;
  branchMatchesBase?: boolean;
  input: Pick<JobInput, "expectPr">;
}): string {
  if (opts.ensureError && isNoCommitsBetweenBasePrError(opts.ensureError)) {
    return NO_COMMITS_BEYOND_BASE_MESSAGE;
  }
  if (opts.branchMatchesBase) {
    return NO_COMMITS_BEYOND_BASE_MESSAGE;
  }
  if (opts.ensureError?.trim()) {
    return `Could not open a GitHub PR after build: ${opts.ensureError.trim()}`;
  }
  return resolvePostBuildNoPr(opts.input).error ?? NO_PR_GUARD_MESSAGE;
}

export function resolvePostBuildNoPr(input: Pick<JobInput, "expectPr">): PostBuildNoPrResolution {
  if (jobExpectsPr(input)) {
    return {
      kind: "stuck",
      error: NO_PR_GUARD_MESSAGE,
    };
  }
  return { kind: "complete", error: null };
}
