import type { RunnerConfig } from "./config.js";
import type { JobInput, JobRecord } from "./types.js";
import { BUILTIN_FIX_MODEL } from "./runner-policy.js";
import type { RunnerSettings, StageModelDefaults } from "./settings.js";
import { ValidationError } from "./validation-error.js";

export type ResolvedStageModels = {
  build: string;
  review: string;
  fix: string;
};

export type ModelSource = "job" | "preset" | "settings" | "env" | "builtin";

export type ResolvedStageModelsWithSources = ResolvedStageModels & {
  sources: Record<keyof ResolvedStageModels, ModelSource>;
};

/** Only cursor-agent resolves the `auto` model id; claude/ollama would receive it literally. */
const AUTO_SUPPORTED_DRIVERS = new Set(["cursor-agent"]);

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

type ModelCandidate = readonly [value: string | null | undefined, source: ModelSource];

type ResolvedModel = { value: string; source: ModelSource };

function firstModel(candidates: ModelCandidate[], fallback: ResolvedModel): ResolvedModel {
  for (const [value, source] of candidates) {
    const v = value?.trim();
    if (v) return { value: v, source };
  }
  return fallback;
}

/**
 * Resolve per-stage models at job creation. Each stage takes the first value set, in order:
 * request `stageModels[stage]`, request `model` (legacy, every stage), settings
 * `stageModels[stage]`, the stage default (build: settings `defaultModel`; review: the settings
 * build model; fix: `auto` on drivers that support it, else the build model), then the env model.
 */
export function resolveStageModelsForJob(
  config: RunnerConfig,
  settings: RunnerSettings,
  input: JobInput,
  driverId: string,
): ResolvedStageModelsWithSources {
  const supportsAuto = driverSupportsAuto(driverId);
  const requested = input.stageModels;
  const requestAll = input.model;
  const defaults = settings.stageModels;
  const env: ResolvedModel = { value: config.defaultModel, source: "env" };

  const settingsBuild: ModelCandidate[] = [
    [defaults.build, "settings"],
    [settings.defaultModel, "settings"],
  ];
  const build = firstModel([[requested?.build, "job"], [requestAll, "job"], ...settingsBuild], env);
  const review = firstModel(
    [
      [requested?.review, "job"],
      [requestAll, "job"],
      [defaults.review, "settings"],
      ...settingsBuild,
    ],
    env,
  );
  const settingsFix = defaults.fix?.trim();
  const fix = firstModel(
    [
      [requested?.fix, "job"],
      [requestAll, "job"],
      [settingsFix === "auto" && !supportsAuto ? null : settingsFix, "settings"],
      [supportsAuto ? BUILTIN_FIX_MODEL : null, "builtin"],
    ],
    build,
  );

  for (const [stage, model] of [
    ["fix", fix.value],
    ["build", build.value],
    ["review", review.value],
  ] as const) {
    if (model === "auto" && !supportsAuto) {
      throw new ValidationError(
        `driver ${driverId} does not support model "auto" for ${stage} stage`,
      );
    }
  }

  return {
    build: build.value,
    review: review.value,
    fix: fix.value,
    sources: { build: build.source, review: review.source, fix: fix.source },
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
