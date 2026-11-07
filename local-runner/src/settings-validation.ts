import {
  BUILTIN_DEFAULT_MAX_ROUNDS,
  MAX_ACTIVE_JOBS_MAX,
  MAX_ACTIVE_JOBS_MIN,
  MAX_ROUNDS_MAX,
  MAX_ROUNDS_MIN,
  parseWatchdogPolicy,
} from "./runner-policy.js";
import { driverSupportsAuto } from "./job-models.js";
import type { StartJobArgs } from "./types.js";
import { listBuiltInDriverIds } from "./drivers/built-in.js";

const EXECUTABLE_DRIVERS = new Set(listBuiltInDriverIds());

export function validateMaxRounds(n: unknown): number | undefined {
  if (n === undefined || n === null) return undefined;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error("maxRounds must be a finite number");
  }
  const v = Math.trunc(n);
  if (v < MAX_ROUNDS_MIN || v > MAX_ROUNDS_MAX) {
    throw new Error(`maxRounds must be between ${MAX_ROUNDS_MIN} and ${MAX_ROUNDS_MAX}`);
  }
  return v;
}

export function validateDriverId(driver: unknown): string | undefined {
  if (driver === undefined || driver === null || driver === "") return undefined;
  const id = String(driver).trim();
  if (!EXECUTABLE_DRIVERS.has(id)) {
    throw new Error(
      `driver must be a registered built-in id (${[...EXECUTABLE_DRIVERS].join(", ")})`,
    );
  }
  return id;
}

export function validateStageModel(
  model: unknown,
  driverId: string,
  label: string,
): string | undefined {
  if (model === undefined || model === null || model === "") return undefined;
  const m = String(model).trim();
  if (!m) return undefined;
  if (m === "auto" && !driverSupportsAuto(driverId)) {
    throw new Error(`${label} model "auto" is not supported for driver ${driverId}`);
  }
  return m;
}

export function normalizeStartJobArgs(raw: Record<string, unknown>): StartJobArgs {
  const driver = validateDriverId(raw.driver);
  const driverForValidation = driver ?? "cursor-agent";
  const stageModels =
    raw.stageModels && typeof raw.stageModels === "object" && !Array.isArray(raw.stageModels)
      ? {
          build: validateStageModel(
            (raw.stageModels as Record<string, unknown>).build,
            driverForValidation,
            "build",
          ),
          review: validateStageModel(
            (raw.stageModels as Record<string, unknown>).review,
            driverForValidation,
            "review",
          ),
          fix: validateStageModel(
            (raw.stageModels as Record<string, unknown>).fix,
            driverForValidation,
            "fix",
          ),
        }
      : undefined;

  const legacyModel =
    typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  if (legacyModel === "auto" && !driverSupportsAuto(driverForValidation)) {
    throw new Error(`model "auto" is not supported for driver ${driverForValidation}`);
  }

  const args: StartJobArgs = {
    repoPath: typeof raw.repoPath === "string" ? raw.repoPath : undefined,
    remote: typeof raw.remote === "string" ? raw.remote : undefined,
    branch: typeof raw.branch === "string" ? raw.branch.trim() : "",
    promptFile: typeof raw.promptFile === "string" ? raw.promptFile : undefined,
    reviewPromptFile: typeof raw.reviewPromptFile === "string" ? raw.reviewPromptFile : undefined,
    fixPromptFile: typeof raw.fixPromptFile === "string" ? raw.fixPromptFile : undefined,
    maxRounds: validateMaxRounds(raw.maxRounds),
    model: legacyModel,
    stageModels,
    driver,
    dryRun: typeof raw.dryRun === "boolean" ? raw.dryRun : undefined,
    ticketUrl: typeof raw.ticketUrl === "string" ? raw.ticketUrl : undefined,
    linearIssue: typeof raw.linearIssue === "string" ? raw.linearIssue : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
  };

  if (!args.branch) throw new Error("branch is required");

  if (raw.jobType === "docs" || raw.jobType === "code") args.jobType = raw.jobType;
  if (raw.profile === "docs" || raw.profile === "code") args.profile = raw.profile;
  if (
    raw.docsTemplate === "marketing" ||
    raw.docsTemplate === "policy" ||
    raw.docsTemplate === "research"
  ) {
    args.docsTemplate = raw.docsTemplate;
  }

  return args;
}

export function validateMaxActiveJobs(n: unknown, fallback: number): number {
  if (n === undefined || n === null) return fallback;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error("maxActiveJobs must be a finite number");
  }
  const v = Math.trunc(n);
  if (v < MAX_ACTIVE_JOBS_MIN || v > MAX_ACTIVE_JOBS_MAX) {
    throw new Error(
      `maxActiveJobs must be between ${MAX_ACTIVE_JOBS_MIN} and ${MAX_ACTIVE_JOBS_MAX}`,
    );
  }
  return v;
}

export function validateDefaultMaxRounds(n: unknown): number {
  if (n === undefined || n === null) return BUILTIN_DEFAULT_MAX_ROUNDS;
  return validateMaxRounds(n) ?? BUILTIN_DEFAULT_MAX_ROUNDS;
}

export { parseWatchdogPolicy };
