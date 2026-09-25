import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatExportBlockLabel, needsExportGateEvaluation } from "./export-gate.js";
import { evaluateAndStoreExportGate } from "./export-validation.js";
import { requireGitRoot } from "./git.js";
import { readPluginAgentModel } from "./agent-model.js";
import {
  formatTierMetricsLine,
  resolveImplementorTierHint,
  REVIEWER_SUBAGENT,
  type ImplementorTierHint,
} from "./model-tiers.js";
import { getLocalPr, isArchivedPr, listLocalPrs, refreshLocalPrHead, syncReviewRoundCount } from "./prs.js";
import type { ProgressCallback } from "./progress.js";
import { consoleDir, parseJsonObject, withFileLock, writeJsonFile } from "./store.js";
import type { ExportGateSnapshot, ExportGateStatus, ImplementorTier, LocalPr } from "./types.js";

export interface StewardBinding {
  loopId: string;
  implementorTaskId: string | null;
  reviewerTaskId: string | null;
  updatedAt: string;
}

export type StewardActionKind =
  | "spawn_implementor"
  | "resume_implementor"
  | "spawn_reviewer"
  | "resume_reviewer"
  | "evaluate_export_gate"
  | "handoff_human"
  | "done";

export interface StewardDecision {
  kind: StewardActionKind;
  loopId: string;
  implementorTaskId: string | null;
  reviewerTaskId: string | null;
  /** True when the persisted implementor Task id should be resumed (no twin). */
  resumeSameImplementor: boolean;
  /** Human-exportable only after Reviewer clear and export gate ready. */
  humanExportable: boolean;
  yourTurn: boolean;
  failingCheck: string | null;
  gateStatus: ExportGateStatus | null;
  reason: string;
  /** cheap | strong hint when kind is spawn_implementor (RAD-89). */
  implementorTier?: ImplementorTier | null;
  implementorTierBumpReason?: string | null;
  implementorSubagentType?: string | null;
  reviewerSubagentType?: string | null;
}

export interface StewardNextOptions {
  restart?: boolean;
  implementorMissing?: boolean;
  implementorFailed?: boolean;
  reviewerMissing?: boolean;
  reviewerFailed?: boolean;
  /** When reviewed and the stored gate is pending/stale, run the full export gate. Default true. */
  evaluateGate?: boolean;
  /** Live CI progress for agent-chat card + panel (same abort as the sidebar). */
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export interface BindStewardInput {
  implementorTaskId?: string | null;
  reviewerTaskId?: string | null;
}

export interface StewardNextResult {
  binding: StewardBinding;
  decision: StewardDecision;
  status: LocalPr["status"];
  exportGate: ExportGateSnapshot | null;
  implementorTierHint: ImplementorTierHint | null;
  reviewRoundCount: number;
  implementorRoundCount: number;
  implementorModel: string | null;
}

interface StewardMapState {
  updatedAt: string;
  bindings: Record<string, StewardBinding>;
}

function stewardsFile(dir: string): string {
  return path.join(dir, "stewards.json");
}

const emptyMap = (): StewardMapState => ({
  updatedAt: new Date(0).toISOString(),
  bindings: {},
});

function parseTaskId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBinding(raw: unknown): StewardBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed.loopId !== "string" || !parsed.loopId) return null;
  return {
    loopId: parsed.loopId,
    implementorTaskId: parseTaskId(parsed.implementorTaskId),
    reviewerTaskId: parseTaskId(parsed.reviewerTaskId),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
  };
}

function parseMap(raw: string): StewardMapState {
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : emptyMap().updatedAt;
  const bindings: Record<string, StewardBinding> = {};
  const rawBindings = parsed.bindings;
  if (rawBindings && typeof rawBindings === "object" && !Array.isArray(rawBindings)) {
    for (const value of Object.values(rawBindings as Record<string, unknown>)) {
      const binding = parseBinding(value);
      if (binding) bindings[binding.loopId] = binding;
    }
  }
  return { updatedAt, bindings };
}

async function loadMap(file: string): Promise<StewardMapState> {
  try {
    return parseMap(await readFile(file, "utf8"));
  } catch {
    return emptyMap();
  }
}

async function pruneStale(cwd: string, state: StewardMapState): Promise<StewardMapState> {
  const live = (await listLocalPrs(cwd)).filter((pr) => !isArchivedPr(pr));
  const liveIds = new Set(live.map((pr) => pr.id));
  const bindings: Record<string, StewardBinding> = {};
  for (const binding of Object.values(state.bindings)) {
    if (!liveIds.has(binding.loopId)) continue;
    bindings[binding.loopId] = binding;
  }
  return { updatedAt: state.updatedAt, bindings };
}

function emptyBinding(loopId: string): StewardBinding {
  return {
    loopId,
    implementorTaskId: null,
    reviewerTaskId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

/** A persisted steward row means this loop is steward-owned (Task ids may still be empty). */
export function isStewardOwned(binding: StewardBinding | null | undefined): boolean {
  return Boolean(binding);
}

function canResumeTask(
  taskId: string | null,
  missing?: boolean,
  failed?: boolean,
  restart?: boolean,
): boolean {
  return Boolean(taskId) && !missing && !failed && !restart;
}

/**
 * Pure next-action for one steward per loop.
 * Human handoff (Push to origin) only when status is reviewed and the export gate is ready.
 */
export function decideStewardAction(
  pr: Pick<LocalPr, "id" | "status" | "headSha" | "exportGate">,
  binding: StewardBinding | null,
  options: StewardNextOptions = {},
): StewardDecision {
  const current = binding ?? emptyBinding(pr.id);
  const implementorTaskId = current.implementorTaskId;
  const reviewerTaskId = current.reviewerTaskId;
  const resumeImplementor = canResumeTask(
    implementorTaskId,
    options.implementorMissing,
    options.implementorFailed,
    options.restart,
  );
  const resumeReviewer = canResumeTask(
    reviewerTaskId,
    options.reviewerMissing,
    options.reviewerFailed,
    options.restart,
  );

  if (pr.status === "approved") {
    return {
      kind: "done",
      loopId: pr.id,
      implementorTaskId,
      reviewerTaskId,
      resumeSameImplementor: false,
      humanExportable: false,
      yourTurn: false,
      failingCheck: null,
      gateStatus: null,
      reason: "Loop is archived. Steward is done.",
    };
  }

  if (pr.status === "ready" || pr.status === "review_interrupted") {
    if (pr.status === "review_interrupted") {
      if (resumeReviewer) {
        return {
          kind: "resume_reviewer",
          loopId: pr.id,
          implementorTaskId,
          reviewerTaskId,
          resumeSameImplementor: false,
          humanExportable: false,
          yourTurn: false,
          failingCheck: null,
          gateStatus: null,
          reason:
            "review_interrupted (auth/host). Resume the same reviewer Task — no re-brief. Or prgenie review-resume / MCP resume_review.",
        };
      }
      return {
        kind: "spawn_reviewer",
        loopId: pr.id,
        implementorTaskId,
        reviewerTaskId: null,
        resumeSameImplementor: false,
        humanExportable: false,
        yourTurn: false,
        failingCheck: null,
        gateStatus: null,
        reason:
          "review_interrupted and reviewer Task missing/failed. Spawn a reviewer Task (thin packet) and persist reviewerTaskId.",
      };
    }
    if (resumeReviewer) {
      return {
        kind: "resume_reviewer",
        loopId: pr.id,
        implementorTaskId,
        reviewerTaskId,
        resumeSameImplementor: false,
        humanExportable: false,
        yourTurn: false,
        failingCheck: null,
        gateStatus: null,
        reason: "Loop is ready. Resume the same reviewer Task.",
      };
    }
    return {
      kind: "spawn_reviewer",
      loopId: pr.id,
      implementorTaskId,
      reviewerTaskId: null,
      resumeSameImplementor: false,
      humanExportable: false,
      yourTurn: false,
      failingCheck: null,
      gateStatus: null,
      reason: "Loop is ready. Spawn a reviewer Task and persist reviewerTaskId.",
    };
  }

  if (pr.status === "reviewed") {
    const gate = pr.exportGate ?? null;
    const gateStatus = gate && gate.headSha === pr.headSha ? gate.status : null;
    if (!gateStatus || gateStatus === "pending") {
      return {
        kind: "evaluate_export_gate",
        loopId: pr.id,
        implementorTaskId,
        reviewerTaskId,
        resumeSameImplementor: false,
        humanExportable: false,
        yourTurn: false,
        failingCheck: null,
        gateStatus: gateStatus ?? "pending",
        reason: "Reviewer cleared. Run the full export gate before any human handoff.",
      };
    }
    if (gateStatus === "blocked") {
      const failingCheck = formatExportBlockLabel(gate?.reasons ?? [], gate);
      if (resumeImplementor) {
        return {
          kind: "resume_implementor",
          loopId: pr.id,
          implementorTaskId,
          reviewerTaskId,
          resumeSameImplementor: true,
          humanExportable: false,
          yourTurn: false,
          failingCheck,
          gateStatus,
          reason:
            failingCheck === "ci-select"
              ? `Export gate blocked (${failingCheck}): stale/refused CI plan — re-run the gate with worktree select (do not fix root pnpm test). Resume the same implementor Task, then evaluate_export_gate again. Do not auto-spawn a reviewer — do not show Push to origin.`
              : `Export gate blocked (${failingCheck}). Resume the same implementor Task, then evaluate_export_gate again. Do not auto-spawn a reviewer — do not show Push to origin.`,
        };
      }
      return {
        kind: "spawn_implementor",
        loopId: pr.id,
        implementorTaskId: null,
        reviewerTaskId,
        resumeSameImplementor: false,
        humanExportable: false,
        yourTurn: false,
        failingCheck,
        gateStatus,
        reason:
          failingCheck === "ci-select"
            ? `Export gate blocked (${failingCheck}): stale/refused CI plan — re-run the gate with worktree select (do not fix root pnpm test). Spawn an implementor Task, then evaluate_export_gate again. Do not auto-spawn a reviewer — do not show Push to origin.`
            : `Export gate blocked (${failingCheck}). Spawn an implementor Task, then evaluate_export_gate again. Do not auto-spawn a reviewer — do not show Push to origin.`,
      };
    }
    return {
      kind: "handoff_human",
      loopId: pr.id,
      implementorTaskId,
      reviewerTaskId,
      resumeSameImplementor: false,
      humanExportable: true,
      yourTurn: true,
      failingCheck: null,
      gateStatus,
      reason: "Export gate ready. Hand off to the human for Push to origin.",
    };
  }

  // draft or changes_requested (and any other live status)
  if (resumeImplementor) {
    return {
      kind: "resume_implementor",
      loopId: pr.id,
      implementorTaskId,
      reviewerTaskId,
      resumeSameImplementor: true,
      humanExportable: false,
      yourTurn: false,
      failingCheck: null,
      gateStatus: null,
      reason:
        pr.status === "changes_requested"
          ? "changes_requested. Resume the same implementor Task id (do not spawn a twin)."
          : "Resume the same implementor Task to continue the draft.",
    };
  }
  return {
    kind: "spawn_implementor",
    loopId: pr.id,
    implementorTaskId: null,
    reviewerTaskId,
    resumeSameImplementor: false,
    humanExportable: false,
    yourTurn: false,
    failingCheck: null,
    gateStatus: null,
    reason:
      pr.status === "changes_requested"
        ? "changes_requested and implementor Task is missing/failed/restart. Spawn a new implementor."
        : "Spawn an implementor Task and persist implementorTaskId.",
  };
}

export async function bindSteward(
  cwd: string,
  id: string,
  input: BindStewardInput = {},
): Promise<StewardBinding> {
  const root = await requireGitRoot(cwd);
  const pr = await getLocalPr(root, id);
  const file = stewardsFile(await consoleDir(root));
  const binding = await withFileLock(file, async () => {
    const current = await pruneStale(root, await loadMap(file));
    const existing = current.bindings[pr.id] ?? emptyBinding(pr.id);
    const next: StewardBinding = {
      loopId: pr.id,
      implementorTaskId:
        input.implementorTaskId === undefined
          ? existing.implementorTaskId
          : parseTaskId(input.implementorTaskId),
      reviewerTaskId:
        input.reviewerTaskId === undefined
          ? existing.reviewerTaskId
          : parseTaskId(input.reviewerTaskId),
      updatedAt: new Date().toISOString(),
    };
    current.bindings[pr.id] = next;
    current.updatedAt = next.updatedAt;
    await writeJsonFile(file, current);
    return { next, existing };
  });

  const newImpl = binding.next.implementorTaskId;
  const oldImpl = binding.existing.implementorTaskId;
  if (newImpl && newImpl !== oldImpl) {
    const { recordImplementorSpawnMetrics } = await import("./prs.js");
    const gateBlocked =
      pr.status === "reviewed" &&
      pr.exportGate?.status === "blocked" &&
      pr.exportGate.headSha === pr.headSha;
    const hint = resolveImplementorTierHint(pr, { ciResume: gateBlocked });
    const model = await readPluginAgentModel(root, hint.subagentType);
    await recordImplementorSpawnMetrics(root, pr.id, {
      tier: hint.tier,
      subagentType: hint.subagentType,
      bumpReason: hint.bumpReason,
      model,
    });
  }

  return binding.next;
}

export async function getStewardBinding(cwd: string, id: string): Promise<StewardBinding | null> {
  const root = await requireGitRoot(cwd);
  const pr = await getLocalPr(root, id);
  const file = stewardsFile(await consoleDir(root));
  return withFileLock(file, async () => {
    const current = await pruneStale(root, await loadMap(file));
    await writeJsonFile(file, current);
    return current.bindings[pr.id] ?? null;
  });
}

export async function listStewardBindings(cwd: string): Promise<StewardBinding[]> {
  const root = await requireGitRoot(cwd);
  const file = stewardsFile(await consoleDir(root));
  return withFileLock(file, async () => {
    const current = await pruneStale(root, await loadMap(file));
    await writeJsonFile(file, current);
    return Object.values(current.bindings);
  });
}

export async function clearStewardBinding(cwd: string, id: string): Promise<void> {
  const root = await requireGitRoot(cwd);
  const pr = await getLocalPr(root, id);
  const file = stewardsFile(await consoleDir(root));
  await withFileLock(file, async () => {
    const current = await pruneStale(root, await loadMap(file));
    delete current.bindings[pr.id];
    current.updatedAt = new Date().toISOString();
    await writeJsonFile(file, current);
  });
}

/**
 * Load the durable map, optionally persist Task ids, run the export gate when
 * the reviewer has cleared, then return the next steward action.
 */
function isCiResumeSpawn(
  decision: Pick<StewardDecision, "kind" | "failingCheck">,
  options: StewardNextOptions,
): boolean {
  if (decision.kind !== "spawn_implementor" || !decision.failingCheck) return false;
  if (options.restart) return false;
  return true;
}

function attachReviewerSubagent(decision: StewardDecision): StewardDecision {
  if (decision.kind === "spawn_reviewer" || decision.kind === "resume_reviewer") {
    return { ...decision, reviewerSubagentType: REVIEWER_SUBAGENT };
  }
  return decision;
}

async function attachImplementorTierHint(
  root: string,
  pr: LocalPr,
  decision: StewardDecision,
  options: StewardNextOptions,
): Promise<{ decision: StewardDecision; tierHint: ImplementorTierHint | null }> {
  let current = attachReviewerSubagent(decision);
  if (current.kind !== "spawn_implementor") {
    return { decision: current, tierHint: null };
  }

  const ciResume = isCiResumeSpawn(current, options);
  const hint = resolveImplementorTierHint(pr, { ciResume, restart: options.restart });
  current = {
    ...current,
    implementorTier: hint.tier,
    implementorTierBumpReason: hint.bumpReason,
    implementorSubagentType: hint.subagentType,
  };
  if (hint.bumpReason) {
    current.reason = `${current.reason} Tier bump (${hint.tier}): ${hint.bumpReason}.`;
  } else {
    current.reason = `${current.reason} Implementor tier: ${hint.tier} (${hint.subagentType}).`;
  }
  return { decision: current, tierHint: hint };
}

export async function stewardNext(
  cwd: string,
  id: string,
  options: StewardNextOptions & BindStewardInput = {},
): Promise<StewardNextResult> {
  const root = await requireGitRoot(cwd);
  // RAD-125: refresh packet headSha from worktree/branch tip BEFORE reading
  // exportGate / blocked-check labels (stale HEAD matched the wrong gate).
  // RAD-126: refresh also invalidates reviewed → ready when tip moved.
  let pr = await refreshLocalPrHead(root, id);
  syncReviewRoundCount(pr);
  // Persist ownership on first next-action so the legacy stop hook stays silent
  // even before implementor/reviewer Task ids are known.
  const binding = await bindSteward(root, pr.id, {
    implementorTaskId: options.implementorTaskId,
    reviewerTaskId: options.reviewerTaskId,
  });

  if (pr.status === "reviewed" && options.evaluateGate !== false && needsExportGateEvaluation(pr)) {
    await evaluateAndStoreExportGate(root, pr.id, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
    pr = await refreshLocalPrHead(root, pr.id);
    syncReviewRoundCount(pr);
  }

  const baseDecision = decideStewardAction(pr, binding, options);
  const tiered = await attachImplementorTierHint(root, pr, baseDecision, options);
  const fresh = await getLocalPr(root, pr.id);

  return {
    binding,
    decision: tiered.decision,
    status: fresh.status,
    exportGate: fresh.exportGate ?? null,
    implementorTierHint: tiered.tierHint,
    reviewRoundCount: fresh.reviewRoundCount ?? syncReviewRoundCount(fresh),
    implementorRoundCount: fresh.implementorRoundCount ?? 0,
    implementorModel: fresh.implementorModel ?? null,
  };
}

export function formatStewardDecision(result: StewardNextResult): string {
  const { binding, decision } = result;
  const lines = [
    `${decision.loopId}  action=${decision.kind}  status=${result.status}`,
    `  implementorTaskId=${binding.implementorTaskId ?? "-"}  reviewerTaskId=${binding.reviewerTaskId ?? "-"}`,
    `  resumeSameImplementor=${decision.resumeSameImplementor}  humanExportable=${decision.humanExportable}  yourTurn=${decision.yourTurn}`,
  ];
  if (decision.implementorSubagentType) {
    lines.push(
      `  implementorSubagentType=${decision.implementorSubagentType}  implementorTier=${decision.implementorTier ?? "-"}`,
    );
    if (decision.implementorTierBumpReason) {
      lines.push(`  tierBumpReason=${decision.implementorTierBumpReason}`);
    }
  }
  if (decision.reviewerSubagentType) {
    lines.push(`  reviewerSubagentType=${decision.reviewerSubagentType}`);
  }
  lines.push(
    formatTierMetricsLine({
      implementorTier: decision.implementorTier ?? null,
      implementorModel: result.implementorModel,
      reviewRoundCount: result.reviewRoundCount,
      implementorRoundCount: result.implementorRoundCount,
    }),
  );
  if (decision.failingCheck) lines.push(`  failingCheck=${decision.failingCheck}`);
  if (decision.gateStatus) lines.push(`  exportGate=${decision.gateStatus}`);
  lines.push(`  ${decision.reason}`);
  return lines.join("\n");
}

export function formatStewardBinding(binding: StewardBinding): string {
  return `${binding.loopId}  implementor=${binding.implementorTaskId ?? "-"}  reviewer=${binding.reviewerTaskId ?? "-"}`;
}
