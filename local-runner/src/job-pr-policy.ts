import type { JobInput } from "./types.js";

/** Default true: jobs without a GitHub PR after build are stuck unless opted out. */
export function jobExpectsPr(input: Pick<JobInput, "expectPr">): boolean {
  return input.expectPr !== false;
}

export type PostBuildNoPrResolution =
  { kind: "stuck"; error: string } | { kind: "complete"; error: null };

export const NO_PR_GUARD_MESSAGE =
  "No GitHub PR for branch after build (local diff guard). The runner could not commit, push, and open a draft PR. Use continue_job or add git instructions to your prompt.";

export function resolvePostBuildNoPr(input: Pick<JobInput, "expectPr">): PostBuildNoPrResolution {
  if (jobExpectsPr(input)) {
    return {
      kind: "stuck",
      error: NO_PR_GUARD_MESSAGE,
    };
  }
  return { kind: "complete", error: null };
}
