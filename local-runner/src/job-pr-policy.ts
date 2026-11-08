import type { JobInput } from "./types.js";

/** Default true: jobs without a GitHub PR after build are stuck unless opted out. */
export function jobExpectsPr(input: Pick<JobInput, "expectPr">): boolean {
  return input.expectPr !== false;
}

export type PostBuildNoPrResolution =
  { kind: "stuck"; error: string } | { kind: "complete"; error: null };

export function resolvePostBuildNoPr(input: Pick<JobInput, "expectPr">): PostBuildNoPrResolution {
  if (jobExpectsPr(input)) {
    return {
      kind: "stuck",
      error: "No GitHub PR for branch — local-only diff guard",
    };
  }
  return { kind: "complete", error: null };
}
