import { readFile, mkdir, rename, writeFile, access } from "node:fs/promises";
import { parseDocsSettings, type ParsedDocsSettings } from "./docs-settings.js";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { notifySettingsFile, runnerSettingsFile } from "./paths.js";
import {
  BUILTIN_DEFAULT_MAX_ROUNDS,
  BUILTIN_FIX_MODEL,
  DEFAULT_WATCHDOG,
  MAX_ACTIVE_JOBS_DEFAULT,
  parseWatchdogPolicy,
} from "./runner-policy.js";
import { normalizeStageModels } from "./job-models.js";
import {
  validateDefaultMaxRounds,
  validateMaxActiveJobs,
  validateWatchdogPatch,
} from "./settings-validation.js";

export type DriverKind = "cursor-agent" | "claude-code" | "local-model" | "custom";

export type DriverEntry = {
  id: string;
  kind: DriverKind;
  /** CLI binary name or path */
  binary?: string | null;
  /** HTTP base URL for local-model style drivers */
  endpoint?: string | null;
  notes?: string | null;
  /** Masked on public API read-back */
  apiKey?: string | null;
};

export type StageModelDefaults = {
  build: string | null;
  review: string | null;
  fix: string | null;
};

export type NotifyEventSettings = {
  onFailed: boolean;
  onStuck: boolean;
  onWatchdogExhausted: boolean;
};

export type RunnerSettings = {
  version: 1 | 2;
  /** Set true after first explicit save from setup (or migration). */
  configured: boolean;
  /** Monotonic revision for optimistic concurrent-save detection. */
  settingsRevision: number;
  notify: {
    enabled: boolean;
    recipient: string | null;
  };
  notifyEvents: NotifyEventSettings;
  defaultModel: string | null;
  defaultDriver: string | null;
  defaultMaxRounds: number;
  stageModels: StageModelDefaults;
  watchdog: ReturnType<typeof parseWatchdogPolicy>;
  maxActiveJobs: number;
  /** null or "auto" = detect repository default branch; otherwise explicit git ref. */
  defaultBaseBranch: string | null;
  /** Display-only hint; server may still bind from env. */
  hostBindHint: string | null;
  drivers: DriverEntry[];
  /** Reserved for docs presets — opaque bag. */
  jobTypes: Record<string, unknown>;
  presets: Record<string, unknown>;
};

export type DriverEntryPublic = Omit<DriverEntry, "apiKey"> & {
  apiKeyMasked: string | null;
  hasApiKey: boolean;
};

export type RunnerSettingsPublic = Omit<RunnerSettings, "drivers"> & {
  dataDirNote: string;
  envDefaultModel: string;
  envDefaultFixModel: string;
  envHostBind: string;
  resendConfigured: boolean;
  envFallbackRecipient: string | null;
  effectiveDefaultMaxRounds: number;
  drivers: DriverEntryPublic[];
  docsSettings: ParsedDocsSettings;
  envDefaultCodeRepoPath: string | null;
  /** Documented nice-to-haves (not implemented as persistent knobs). */
  policyNotes: {
    ciPollIntervalMs: number;
    mergedHideAfterMs: number;
    worktreeCleanupGraceMs: number | null;
    logRetention: string;
  };
};

const DEFAULT_DRIVERS: DriverEntry[] = [
  {
    id: "cursor-agent",
    kind: "cursor-agent",
    binary: "cursor-agent",
    notes: "Default Cursor agent CLI",
  },
  {
    id: "claude-code",
    kind: "claude-code",
    binary: "claude",
    notes: "Claude Code CLI (-p prompt, --output-format stream-json when supported)",
  },
  {
    id: "local-model",
    kind: "local-model",
    binary: "ollama",
    endpoint: "http://127.0.0.1:11434",
    notes: "Local Ollama; model from job or defaultModel",
  },
];

const DEFAULT_NOTIFY_EVENTS: NotifyEventSettings = {
  onFailed: true,
  onStuck: true,
  onWatchdogExhausted: true,
};

const DEFAULT_STAGE_MODELS: StageModelDefaults = {
  build: null,
  review: null,
  fix: BUILTIN_FIX_MODEL,
};

const DEFAULT: RunnerSettings = {
  version: 2,
  configured: false,
  settingsRevision: 0,
  notify: { enabled: false, recipient: null },
  notifyEvents: { ...DEFAULT_NOTIFY_EVENTS },
  defaultModel: null,
  defaultDriver: "cursor-agent",
  defaultMaxRounds: BUILTIN_DEFAULT_MAX_ROUNDS,
  stageModels: { ...DEFAULT_STAGE_MODELS },
  watchdog: { ...DEFAULT_WATCHDOG },
  maxActiveJobs: MAX_ACTIVE_JOBS_DEFAULT,
  defaultBaseBranch: null,
  hostBindHint: null,
  drivers: DEFAULT_DRIVERS,
  jobTypes: {},
  presets: {},
};

function parseNotifyEvents(raw: Partial<NotifyEventSettings> | undefined): NotifyEventSettings {
  return {
    onFailed: raw?.onFailed !== undefined ? Boolean(raw.onFailed) : DEFAULT_NOTIFY_EVENTS.onFailed,
    onStuck: raw?.onStuck !== undefined ? Boolean(raw.onStuck) : DEFAULT_NOTIFY_EVENTS.onStuck,
    onWatchdogExhausted:
      raw?.onWatchdogExhausted !== undefined
        ? Boolean(raw.onWatchdogExhausted)
        : DEFAULT_NOTIFY_EVENTS.onWatchdogExhausted,
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

function normalizeDriverEntry(raw: Partial<DriverEntry>): DriverEntry | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const kind = (raw.kind ?? "custom") as DriverKind;
  return {
    id,
    kind,
    binary: typeof raw.binary === "string" ? raw.binary.trim() || null : (raw.binary ?? null),
    endpoint:
      typeof raw.endpoint === "string" ? raw.endpoint.trim() || null : (raw.endpoint ?? null),
    notes: typeof raw.notes === "string" ? raw.notes.trim() || null : (raw.notes ?? null),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() || null : (raw.apiKey ?? null),
  };
}

function mergeDrivers(existing: DriverEntry[], patch: DriverEntry[] | undefined): DriverEntry[] {
  if (!patch?.length) return existing.length ? existing : [...DEFAULT_DRIVERS];
  const byId = new Map(existing.map((d) => [d.id, d]));
  for (const entry of patch) {
    const norm = normalizeDriverEntry(entry);
    if (!norm) continue;
    const prev = byId.get(norm.id);
    if (prev && norm.apiKey == null && prev.apiKey) {
      norm.apiKey = prev.apiKey;
    }
    byId.set(norm.id, norm);
  }
  return [...byId.values()];
}

function migrateLegacySingleModel(raw: Partial<RunnerSettings>): StageModelDefaults {
  const stage = normalizeStageModels(raw.stageModels);
  if (stage.build || stage.review) return stage;
  if (typeof raw.defaultModel === "string" && raw.defaultModel.trim()) {
    return { build: raw.defaultModel.trim(), review: null, fix: stage.fix ?? BUILTIN_FIX_MODEL };
  }
  return { ...DEFAULT_STAGE_MODELS, ...stage };
}

function parseSettings(raw: Partial<RunnerSettings>): RunnerSettings {
  const version = raw.version === 2 || raw.defaultMaxRounds !== undefined ? 2 : 1;
  const stageModels = migrateLegacySingleModel(raw);
  return {
    version: version === 2 ? 2 : 1,
    configured: Boolean(raw.configured),
    settingsRevision:
      typeof raw.settingsRevision === "number" && Number.isFinite(raw.settingsRevision)
        ? Math.max(0, Math.trunc(raw.settingsRevision))
        : raw.configured
          ? 1
          : 0,
    notify: {
      enabled: Boolean(raw.notify?.enabled),
      recipient:
        typeof raw.notify?.recipient === "string" && raw.notify.recipient.trim()
          ? raw.notify.recipient.trim()
          : null,
    },
    notifyEvents: parseNotifyEvents(raw.notifyEvents),
    defaultModel:
      typeof raw.defaultModel === "string" && raw.defaultModel.trim()
        ? raw.defaultModel.trim()
        : null,
    defaultDriver:
      typeof raw.defaultDriver === "string" && raw.defaultDriver.trim()
        ? raw.defaultDriver.trim()
        : "cursor-agent",
    defaultMaxRounds: validateDefaultMaxRounds(raw.defaultMaxRounds),
    stageModels,
    watchdog: parseWatchdogPolicy(raw.watchdog),
    maxActiveJobs: validateMaxActiveJobs(raw.maxActiveJobs, MAX_ACTIVE_JOBS_DEFAULT),
    defaultBaseBranch:
      typeof raw.defaultBaseBranch === "string" && raw.defaultBaseBranch.trim()
        ? raw.defaultBaseBranch.trim()
        : null,
    hostBindHint:
      typeof raw.hostBindHint === "string" && raw.hostBindHint.trim()
        ? raw.hostBindHint.trim()
        : null,
    drivers: mergeDrivers(
      Array.isArray(raw.drivers)
        ? raw.drivers
            .map((d) => normalizeDriverEntry(d as Partial<DriverEntry>))
            .filter((d): d is DriverEntry => d != null)
        : [],
      undefined,
    ),
    jobTypes:
      raw.jobTypes && typeof raw.jobTypes === "object" && !Array.isArray(raw.jobTypes)
        ? { ...(raw.jobTypes as Record<string, unknown>) }
        : {},
    presets:
      raw.presets && typeof raw.presets === "object" && !Array.isArray(raw.presets)
        ? { ...(raw.presets as Record<string, unknown>) }
        : {},
  };
}

async function migrateNotifyFile(dataDir: string): Promise<RunnerSettings | null> {
  try {
    await access(notifySettingsFile(dataDir));
  } catch {
    return null;
  }
  try {
    const legacy = JSON.parse(await readFile(notifySettingsFile(dataDir), "utf8")) as {
      enabled?: boolean;
      recipient?: string | null;
    };
    const migrated = parseSettings({
      configured: true,
      notify: {
        enabled: Boolean(legacy.enabled),
        recipient:
          typeof legacy.recipient === "string" && legacy.recipient.trim()
            ? legacy.recipient.trim()
            : null,
      },
    });
    await atomicWriteJson(runnerSettingsFile(dataDir), migrated);
    return migrated;
  } catch {
    return null;
  }
}

export async function loadSettings(dataDir: string): Promise<RunnerSettings> {
  try {
    const raw = JSON.parse(
      await readFile(runnerSettingsFile(dataDir), "utf8"),
    ) as Partial<RunnerSettings>;
    return parseSettings(raw);
  } catch {
    const migrated = await migrateNotifyFile(dataDir);
    if (migrated) return migrated;
    return { ...DEFAULT, drivers: [...DEFAULT_DRIVERS] };
  }
}

export type SettingsPatch = {
  configured?: boolean;
  expectedRevision?: number;
  notify?: Partial<RunnerSettings["notify"]>;
  notifyEvents?: Partial<NotifyEventSettings>;
  defaultModel?: string | null;
  defaultDriver?: string | null;
  defaultMaxRounds?: number;
  stageModels?: Partial<StageModelDefaults>;
  watchdog?: Partial<RunnerSettings["watchdog"]>;
  maxActiveJobs?: number;
  defaultBaseBranch?: string | null;
  hostBindHint?: string | null;
  drivers?: DriverEntry[];
  jobTypes?: Record<string, unknown>;
  presets?: Record<string, unknown>;
};

export class SettingsConflictError extends Error {
  constructor() {
    super("settings changed on disk; reload and retry");
    this.name = "SettingsConflictError";
  }
}

function mergeStageModels(
  current: StageModelDefaults,
  patch: Partial<StageModelDefaults> | undefined,
): StageModelDefaults {
  if (!patch) return current;
  return normalizeStageModels({
    build: patch.build !== undefined ? patch.build : current.build,
    review: patch.review !== undefined ? patch.review : current.review,
    fix: patch.fix !== undefined ? patch.fix : current.fix,
  });
}

function shallowMergeJobTypes(
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch) return current;
  return { ...current, ...patch };
}

export async function saveSettings(dataDir: string, patch: SettingsPatch): Promise<RunnerSettings> {
  const current = await loadSettings(dataDir);
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.settingsRevision) {
    throw new SettingsConflictError();
  }
  const next = parseSettings({
    ...current,
    version: 2,
    configured: patch.configured !== undefined ? Boolean(patch.configured) : true,
    settingsRevision: current.settingsRevision + 1,
    notify: {
      enabled:
        patch.notify?.enabled !== undefined
          ? Boolean(patch.notify.enabled)
          : current.notify.enabled,
      recipient:
        patch.notify?.recipient !== undefined
          ? patch.notify.recipient?.trim() || null
          : current.notify.recipient,
    },
    notifyEvents: {
      ...current.notifyEvents,
      ...(patch.notifyEvents ?? {}),
    },
    defaultModel:
      patch.defaultModel !== undefined ? patch.defaultModel?.trim() || null : current.defaultModel,
    defaultDriver:
      patch.defaultDriver !== undefined
        ? patch.defaultDriver?.trim() || "cursor-agent"
        : current.defaultDriver,
    defaultMaxRounds:
      patch.defaultMaxRounds !== undefined
        ? validateDefaultMaxRounds(patch.defaultMaxRounds)
        : current.defaultMaxRounds,
    stageModels: mergeStageModels(current.stageModels, patch.stageModels),
    watchdog:
      patch.watchdog !== undefined
        ? parseWatchdogPolicy({ ...current.watchdog, ...validateWatchdogPatch(patch.watchdog) })
        : current.watchdog,
    maxActiveJobs:
      patch.maxActiveJobs !== undefined
        ? validateMaxActiveJobs(patch.maxActiveJobs, current.maxActiveJobs)
        : current.maxActiveJobs,
    defaultBaseBranch:
      patch.defaultBaseBranch !== undefined
        ? patch.defaultBaseBranch?.trim() || null
        : current.defaultBaseBranch,
    hostBindHint:
      patch.hostBindHint !== undefined ? patch.hostBindHint?.trim() || null : current.hostBindHint,
    drivers:
      patch.drivers !== undefined ? mergeDrivers(current.drivers, patch.drivers) : current.drivers,
    jobTypes:
      patch.jobTypes !== undefined
        ? shallowMergeJobTypes(current.jobTypes, patch.jobTypes)
        : current.jobTypes,
    presets:
      patch.presets !== undefined ? { ...current.presets, ...patch.presets } : current.presets,
  });
  await atomicWriteJson(runnerSettingsFile(dataDir), next);
  return next;
}

export function resolveDefaultMaxRounds(settings: RunnerSettings): number {
  return settings.defaultMaxRounds;
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  if (v.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
}

export function toPublicSettings(
  config: RunnerConfig,
  settings: RunnerSettings,
): RunnerSettingsPublic {
  return {
    ...settings,
    dataDirNote: config.dataDir,
    envDefaultModel: config.defaultModel,
    envDefaultFixModel: BUILTIN_FIX_MODEL,
    envHostBind: `${config.host}:${config.port}`,
    resendConfigured: Boolean(config.resendApiKey),
    envFallbackRecipient: config.notifyEmail,
    effectiveDefaultMaxRounds: resolveDefaultMaxRounds(settings),
    policyNotes: {
      ciPollIntervalMs: 45_000,
      mergedHideAfterMs: 60 * 60 * 1000,
      worktreeCleanupGraceMs: null,
      logRetention: "disabled (no automatic deletion)",
    },
    drivers: settings.drivers.map((d) => ({
      id: d.id,
      kind: d.kind,
      binary: d.binary ?? null,
      endpoint: d.endpoint ?? null,
      notes: d.notes ?? null,
      hasApiKey: Boolean(d.apiKey),
      apiKeyMasked: maskSecret(d.apiKey),
    })),
    docsSettings: parseDocsSettings(settings),
    envDefaultCodeRepoPath: config.defaultCodeRepoPath,
  };
}

export function resolveDefaultModel(config: RunnerConfig, settings: RunnerSettings): string {
  return settings.defaultModel?.trim() || config.defaultModel;
}

export function resolveDefaultDriverId(settings: RunnerSettings): string {
  return settings.defaultDriver?.trim() || "cursor-agent";
}

export function findDriverEntry(settings: RunnerSettings, driverId: string): DriverEntry | null {
  const id = driverId.trim();
  const fromList = settings.drivers.find((d) => d.id === id);
  if (fromList) return fromList;
  if (id === "cursor-agent") return DEFAULT_DRIVERS[0];
  if (id === "claude-code") return DEFAULT_DRIVERS[1];
  if (id === "local-model") return DEFAULT_DRIVERS[2];
  return null;
}
