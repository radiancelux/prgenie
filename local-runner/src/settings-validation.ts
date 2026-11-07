import {
  BUILTIN_DEFAULT_MAX_ROUNDS,
  MAX_ACTIVE_JOBS_MAX,
  MAX_ACTIVE_JOBS_MIN,
  MAX_ROUNDS_MAX,
  MAX_ROUNDS_MIN,
  WATCHDOG_INACTIVITY_MS_MAX,
  WATCHDOG_INACTIVITY_MS_MIN,
  WATCHDOG_RECOVERY_ATTEMPTS_MAX,
  WATCHDOG_RECOVERY_ATTEMPTS_MIN,
  WATCHDOG_STAGE_CAP_MS_MAX,
  WATCHDOG_STAGE_CAP_MS_MIN,
  parseWatchdogPolicy,
  type WatchdogPolicy,
} from "./runner-policy.js";
import { driverSupportsAuto } from "./job-models.js";
import type { JobProfile, StartJobArgs } from "./types.js";
import type {
  DriverEntry,
  NotifyEventSettings,
  SettingsPatch,
  StageModelDefaults,
} from "./settings.js";
import { listBuiltInDriverIds } from "./drivers/built-in.js";

const EXECUTABLE_DRIVERS = new Set(listBuiltInDriverIds());

const JOB_PROFILES: readonly JobProfile[] = ["code", "docs"];
const DOCS_TEMPLATES: readonly NonNullable<StartJobArgs["docsTemplate"]>[] = [
  "marketing",
  "policy",
  "research",
];
const STAGE_MODEL_KEYS: readonly (keyof StageModelDefaults)[] = ["build", "review", "fix"];
const NOTIFY_EVENT_KEYS: readonly (keyof NotifyEventSettings)[] = [
  "onFailed",
  "onStuck",
  "onWatchdogExhausted",
];

/** Caller supplied a bad value; HTTP maps this to 400, MCP to a tool error. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateBoundedInt(n: unknown, label: string, min: number, max: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  const v = Math.trunc(n);
  if (v < min || v > max) {
    throw new ValidationError(`${label} must be between ${min} and ${max}`);
  }
  return v;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  return v;
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`${key} must be a boolean`);
  return v;
}

function optionalEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ValidationError(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export function validateMaxRounds(n: unknown): number | undefined {
  if (n === undefined || n === null) return undefined;
  return validateBoundedInt(n, "maxRounds", MAX_ROUNDS_MIN, MAX_ROUNDS_MAX);
}

export function validateDriverId(driver: unknown): string | undefined {
  if (driver === undefined || driver === null || driver === "") return undefined;
  const id = typeof driver === "string" ? driver.trim() : "";
  if (!EXECUTABLE_DRIVERS.has(id)) {
    throw new ValidationError(
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
  if (typeof model !== "string") {
    throw new ValidationError(`stageModels.${label} must be a string`);
  }
  const m = model.trim();
  if (!m) return undefined;
  if (m === "auto" && !driverSupportsAuto(driverId)) {
    throw new ValidationError(`${label} model "auto" is not supported for driver ${driverId}`);
  }
  return m;
}

/**
 * Single validator for job start input (HTTP POST /api/jobs, MCP start_job, engine.startJob).
 * Every bounded/enum field is checked here so no caller can bypass it.
 */
export function normalizeStartJobArgs(raw: Record<string, unknown>): StartJobArgs {
  const branchRaw = raw.branch;
  if (branchRaw !== undefined && branchRaw !== null && typeof branchRaw !== "string") {
    throw new ValidationError("branch must be a string");
  }
  const branch = typeof branchRaw === "string" ? branchRaw.trim() : "";
  if (!branch) throw new ValidationError("branch is required");

  const repoPath = optionalString(raw, "repoPath");
  const remote = optionalString(raw, "remote");
  const promptFile = optionalString(raw, "promptFile");
  const reviewPromptFile = optionalString(raw, "reviewPromptFile");
  const fixPromptFile = optionalString(raw, "fixPromptFile");
  const modelRaw = optionalString(raw, "model");
  const ticketUrl = optionalString(raw, "ticketUrl");
  const linearIssue = optionalString(raw, "linearIssue");
  const title = optionalString(raw, "title");
  const dryRun = optionalBoolean(raw, "dryRun");
  const maxRounds = validateMaxRounds(raw.maxRounds);
  const driver = validateDriverId(raw.driver);
  const jobType = optionalEnum(raw, "jobType", JOB_PROFILES);
  const profile = optionalEnum(raw, "profile", JOB_PROFILES);
  const docsTemplate = optionalEnum(raw, "docsTemplate", DOCS_TEMPLATES);

  const driverForValidation = driver ?? "cursor-agent";
  let stageModels: StartJobArgs["stageModels"];
  if (raw.stageModels !== undefined && raw.stageModels !== null) {
    if (!isPlainObject(raw.stageModels)) {
      throw new ValidationError("stageModels must be an object");
    }
    const sm = raw.stageModels;
    stageModels = {
      build: validateStageModel(sm.build, driverForValidation, "build"),
      review: validateStageModel(sm.review, driverForValidation, "review"),
      fix: validateStageModel(sm.fix, driverForValidation, "fix"),
    };
  }

  const legacyModel = modelRaw?.trim() || undefined;
  if (legacyModel === "auto" && !driverSupportsAuto(driverForValidation)) {
    throw new ValidationError(`model "auto" is not supported for driver ${driverForValidation}`);
  }

  const isDocs = jobType === "docs" || profile === "docs";
  if (!isDocs && !promptFile?.trim()) {
    throw new ValidationError("promptFile is required for code jobs");
  }
  if (isDocs && !promptFile?.trim() && !docsTemplate) {
    throw new ValidationError("docs jobs need docsTemplate or promptFile");
  }

  const args: StartJobArgs = {
    repoPath,
    remote,
    branch,
    promptFile,
    reviewPromptFile,
    fixPromptFile,
    maxRounds,
    model: legacyModel,
    stageModels,
    driver,
    dryRun,
    ticketUrl,
    linearIssue,
    title,
  };
  if (jobType) args.jobType = jobType;
  if (profile) args.profile = profile;
  if (docsTemplate) args.docsTemplate = docsTemplate;
  return args;
}

export function validateMaxActiveJobs(n: unknown, fallback: number): number {
  if (n === undefined || n === null) return fallback;
  return validateBoundedInt(n, "maxActiveJobs", MAX_ACTIVE_JOBS_MIN, MAX_ACTIVE_JOBS_MAX);
}

export function validateDefaultMaxRounds(n: unknown): number {
  if (n === undefined || n === null) return BUILTIN_DEFAULT_MAX_ROUNDS;
  return validateMaxRounds(n) ?? BUILTIN_DEFAULT_MAX_ROUNDS;
}

/** Strict counterpart of parseWatchdogPolicy for user patches (no silent clamping). */
export function validateWatchdogPatch(raw: unknown): Partial<WatchdogPolicy> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ValidationError("watchdog must be an object");
  const out: Partial<WatchdogPolicy> = {};
  if (raw.inactivityMs !== undefined) {
    out.inactivityMs = validateBoundedInt(
      raw.inactivityMs,
      "watchdog.inactivityMs",
      WATCHDOG_INACTIVITY_MS_MIN,
      WATCHDOG_INACTIVITY_MS_MAX,
    );
  }
  if (raw.stageCapMs !== undefined) {
    out.stageCapMs = validateBoundedInt(
      raw.stageCapMs,
      "watchdog.stageCapMs",
      WATCHDOG_STAGE_CAP_MS_MIN,
      WATCHDOG_STAGE_CAP_MS_MAX,
    );
  }
  if (raw.recoveryAttempts !== undefined) {
    out.recoveryAttempts = validateBoundedInt(
      raw.recoveryAttempts,
      "watchdog.recoveryAttempts",
      WATCHDOG_RECOVERY_ATTEMPTS_MIN,
      WATCHDOG_RECOVERY_ATTEMPTS_MAX,
    );
  }
  return out;
}

function validateStageModelsPatch(raw: unknown): Partial<StageModelDefaults> {
  if (!isPlainObject(raw)) throw new ValidationError("stageModels must be an object");
  const out: Partial<StageModelDefaults> = {};
  for (const key of STAGE_MODEL_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") {
      throw new ValidationError(`stageModels.${key} must be a string or null`);
    }
    out[key] = v;
  }
  return out;
}

function validateNotifyEventsPatch(raw: unknown): Partial<NotifyEventSettings> {
  if (!isPlainObject(raw)) throw new ValidationError("notifyEvents must be an object");
  const out: Partial<NotifyEventSettings> = {};
  for (const key of NOTIFY_EVENT_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new ValidationError(`notifyEvents.${key} must be a boolean`);
    out[key] = v;
  }
  return out;
}

function nullableTrimmed(v: unknown): string | null {
  return v === null || v === "" ? null : String(v).trim();
}

/** Builds a SettingsPatch from a PATCH /api/settings body; throws ValidationError on bad input. */
export function parseSettingsPatch(payload: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (payload.configured !== undefined) patch.configured = Boolean(payload.configured);
  if (payload.defaultModel !== undefined)
    patch.defaultModel = nullableTrimmed(payload.defaultModel);
  if (payload.defaultDriver !== undefined) {
    patch.defaultDriver = String(payload.defaultDriver ?? "").trim() || "cursor-agent";
  }
  if (payload.hostBindHint !== undefined)
    patch.hostBindHint = nullableTrimmed(payload.hostBindHint);
  if (payload.defaultMaxRounds !== undefined) {
    patch.defaultMaxRounds = validateBoundedInt(
      payload.defaultMaxRounds,
      "maxRounds",
      MAX_ROUNDS_MIN,
      MAX_ROUNDS_MAX,
    );
  }
  if (payload.maxActiveJobs !== undefined) {
    patch.maxActiveJobs = validateBoundedInt(
      payload.maxActiveJobs,
      "maxActiveJobs",
      MAX_ACTIVE_JOBS_MIN,
      MAX_ACTIVE_JOBS_MAX,
    );
  }
  if (payload.defaultBaseBranch !== undefined) {
    patch.defaultBaseBranch = nullableTrimmed(payload.defaultBaseBranch);
  }
  if (payload.expectedRevision !== undefined) {
    const rev = payload.expectedRevision;
    if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
      throw new ValidationError("expectedRevision must be a non-negative integer");
    }
    patch.expectedRevision = rev;
  }
  if (payload.stageModels !== undefined && payload.stageModels !== null) {
    patch.stageModels = validateStageModelsPatch(payload.stageModels);
  }
  if (payload.watchdog !== undefined && payload.watchdog !== null) {
    patch.watchdog = validateWatchdogPatch(payload.watchdog);
  }
  if (payload.notifyEvents !== undefined && payload.notifyEvents !== null) {
    patch.notifyEvents = validateNotifyEventsPatch(payload.notifyEvents);
  }
  if (payload.notify) {
    if (!isPlainObject(payload.notify)) throw new ValidationError("notify must be an object");
    patch.notify = {};
    if (payload.notify.enabled !== undefined) {
      patch.notify.enabled = Boolean(payload.notify.enabled);
    }
    if (payload.notify.recipient !== undefined) {
      patch.notify.recipient = nullableTrimmed(payload.notify.recipient);
    }
  }
  if (Array.isArray(payload.drivers)) {
    patch.drivers = payload.drivers.map((d: unknown) => {
      if (!isPlainObject(d)) throw new ValidationError("drivers entries must be objects");
      const apiKey = d.apiKey;
      return {
        id: String(d.id ?? ""),
        kind: d.kind as DriverEntry["kind"],
        binary: (d.binary as string | null | undefined) ?? null,
        endpoint: (d.endpoint as string | null | undefined) ?? null,
        notes: (d.notes as string | null | undefined) ?? null,
        apiKey:
          typeof apiKey === "string" && apiKey.trim() && !/^•+$/.test(apiKey.trim())
            ? apiKey.trim()
            : apiKey === null
              ? null
              : undefined,
      };
    });
  }
  if (payload.jobTypes !== undefined && typeof payload.jobTypes === "object") {
    patch.jobTypes = payload.jobTypes as Record<string, unknown>;
  }
  if (payload.presets !== undefined && typeof payload.presets === "object") {
    patch.presets = payload.presets as Record<string, unknown>;
  }
  return patch;
}

export { parseWatchdogPolicy };
