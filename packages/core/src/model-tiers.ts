import type { ImplementorTier, LocalPr } from "./types.js";

export const IMPLEMENTOR_TIER_CHEAP: ImplementorTier = "cheap";
export const IMPLEMENTOR_TIER_STRONG: ImplementorTier = "strong";

export const IMPLEMENTOR_SUBAGENT_CHEAP = "prgenie-implementor";
export const IMPLEMENTOR_SUBAGENT_STRONG = "prgenie-implementor-strong";
export const REVIEWER_SUBAGENT = "prgenie-reviewer";

export interface ImplementorTierHint {
  tier: ImplementorTier;
  subagentType: string;
  bumpReason: string | null;
}

export interface ResolveImplementorTierInput {
  /** Export-gate CI-resume or format/lint fix spawn — always cheap. */
  ciResume?: boolean;
  /** User/steward asked to restart implementor — re-evaluate tier (not forced cheap). */
  restart?: boolean;
}

const DESIGN_HEAVY_MARKERS = [
  /\bdesign-heavy\b/i,
  /\barchitecture\b/i,
  /\barchitectural\b/i,
  /\bdata model\b/i,
  /\bschema design\b/i,
  /\bapi design\b/i,
  /\bstate machine\b/i,
  /\bconcurrency\b/i,
  /\brace condition\b/i,
  /\bmigration strategy\b/i,
  /\bcross-cutting\b/i,
];

/** Heuristic: brief/AC text signals design-heavy work (explicit marker or keywords). */
export function isDesignHeavyBrief(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  return DESIGN_HEAVY_MARKERS.some((re) => re.test(text));
}

/** Times a new implementor Task was spawned (persisted on packet). */
export function implementorRoundCount(pr: Pick<LocalPr, "implementorRoundCount">): number {
  return pr.implementorRoundCount ?? 0;
}

/** Reviewer rejections while AC stayed open (complete_review → changes_requested). */
export function failedAcRoundCount(pr: Pick<LocalPr, "failedAcRoundCount">): number {
  return pr.failedAcRoundCount ?? 0;
}

/** True when the same AC is still open after two failed implementor rounds (RAD-89). */
export function sameAcStillOpen(pr: Pick<LocalPr, "status" | "failedAcRoundCount">): boolean {
  if (pr.status !== "changes_requested") return false;
  return failedAcRoundCount(pr) >= 2;
}

/**
 * Choose cheap vs strong for a **new** implementor spawn.
 * Resume paths do not call this — CI-resume always stays on the cheap resume Task.
 */
export function resolveImplementorTierHint(
  pr: Pick<LocalPr, "body" | "status" | "failedAcRoundCount">,
  input: ResolveImplementorTierInput = {},
): ImplementorTierHint {
  if (input.ciResume) {
    return {
      tier: IMPLEMENTOR_TIER_CHEAP,
      subagentType: IMPLEMENTOR_SUBAGENT_CHEAP,
      bumpReason: null,
    };
  }

  if (isDesignHeavyBrief(pr.body)) {
    return {
      tier: IMPLEMENTOR_TIER_STRONG,
      subagentType: IMPLEMENTOR_SUBAGENT_STRONG,
      bumpReason: "design-heavy AC in loop brief",
    };
  }

  if (sameAcStillOpen(pr)) {
    return {
      tier: IMPLEMENTOR_TIER_STRONG,
      subagentType: IMPLEMENTOR_SUBAGENT_STRONG,
      bumpReason: "same AC still open after two implementor rounds",
    };
  }

  return {
    tier: IMPLEMENTOR_TIER_CHEAP,
    subagentType: IMPLEMENTOR_SUBAGENT_CHEAP,
    bumpReason: null,
  };
}

export function formatTierMetricsLine(
  pr: Pick<
    LocalPr,
    "implementorTier" | "implementorModel" | "reviewRoundCount" | "implementorRoundCount"
  >,
): string {
  const tier = pr.implementorTier ?? "-";
  const model = pr.implementorModel ?? "-";
  const reviewRounds = pr.reviewRoundCount ?? 0;
  const implRounds = pr.implementorRoundCount ?? 0;
  return `  tier=${tier}  model=${model}  reviewRounds=${reviewRounds}  implementorRounds=${implRounds}`;
}
