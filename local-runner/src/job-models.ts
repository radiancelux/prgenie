import type { RunnerConfig } from "./config.js";
import type { JobInput, JobRecord } from "./types.js";
import { BUILTIN_FIX_MODEL } from "./runner-policy.js";
import { resolveDefaultModel, type RunnerSettings, type StageModelDefaults } from "./settings.js";
import { listBuiltInDriverIds } from "./drivers/built-in.js";

export type ResolvedStageModels = {
  build: string;
  review: string;
  fix: string;
};

export type ModelSource = "job" | "preset" | "settings" | "env" | "builtin";

export type ResolvedStageModelsWithSources = ResolvedStageModels & {
  sources: Record<keyof ResolvedStageModels, ModelSource>;
};

const AUTO_SUPPORTED_DRIVERS = new Set(listBuiltInDriverIds());

export function driverSupportsAuto(driverId: string): boolean {
  return AUTO_SUPPORTED_DRIVERS.has(driverId.trim());
}

export function normalizeStageModels(
  raw: Partial<StageModelDefaults> | undefined,
): StageModelDefaults {
  return {
    build: typeof raw?.build === "string" && raw.build.trim() ? raw.build.trim() : null,
    review: typeof raw?.review === "string" && raw.review.trim() ? raw.review.trim() : null,
    fix: typeof raw?.fix === "string" && raw.fix.trim() ? raw.fix.trim() : null,
  };
}

function resolveOne(
  explicit: string | undefined,
  inherited: string,
  source: ModelSource,
): { value: string; source: ModelSource } {
  const v = explicit?.trim();
  if (v) return { value: v, source: "job" };
  return { value: inherited, source };
}

/**
 * Resolve per-stage models at job creation. Legacy single `model` applies to all stages when set.
 */
export function resolveStageModelsForJob(
  config: RunnerConfig,
  settings: RunnerSettings,
  input: JobInput,
  driverId: string,
): ResolvedStageModelsWithSources {
  const envBuild = resolveDefaultModel(config, settings);
  const defaults = settings.stageModels;
  const settingsBuild = defaults.build?.trim() || settings.defaultModel?.trim() || envBuild;
  const settingsReview = defaults.review?.trim() || settingsBuild;
  const settingsFix = defaults.fix?.trim() || BUILTIN_FIX_MODEL;

  if (input.model?.trim()) {
    const m = input.model.trim();
    return {
      build: m,
      review: m,
      fix: m,
      sources: { build: "job", review: "job", fix: "job" },
    };
  }

  const explicit = input.stageModels;
  const buildR = resolveOne(explicit?.build, settingsBuild, "settings");
  const reviewR = resolveOne(explicit?.review, settingsReview, "settings");
  const fixR = resolveOne(explicit?.fix, settingsFix, "settings");

  for (const pair of [
    ["fix", fixR.value],
    ["build", buildR.value],
    ["review", reviewR.value],
  ] as const) {
    if (pair[1] === "auto" && !driverSupportsAuto(driverId)) {
      throw new Error(`driver ${driverId} does not support model "auto" for ${pair[0]} stage`);
    }
  }

  return {
    build: buildR.value,
    review: reviewR.value,
    fix: fixR.value,
    sources: {
      build: buildR.source === "job" ? "job" : settings.defaultModel ? "settings" : "env",
      review: reviewR.source === "job" ? "job" : "settings",
      fix: fixR.source === "job" ? "job" : "settings",
    },
  };
}

export function modelForActiveStage(
  job: JobRecord,
  stage: "building" | "reviewing" | "fixing",
): string {
  const models = job.stageModels;
  if (!models) return job.model;
  if (stage === "building") return job.stageModelActual?.build ?? models.build;
  if (stage === "reviewing") return job.stageModelActual?.review ?? models.review;
  return job.stageModelActual?.fix ?? models.fix;
}

export function recordActualModel(
  job: JobRecord,
  stage: keyof ResolvedStageModels,
  model: string,
): void {
  if (!job.stageModelActual) job.stageModelActual = {};
  job.stageModelActual[stage] = model;
}
