import { readFile, mkdir, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { notifySettingsFile, runnerSettingsFile } from "./paths.js";

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

export type RunnerSettings = {
  version: 1;
  /** Set true after first explicit save from setup (or migration). */
  configured: boolean;
  notify: {
    enabled: boolean;
    recipient: string | null;
  };
  defaultModel: string | null;
  defaultDriver: string | null;
  /** Display-only hint; server may still bind from env. */
  hostBindHint: string | null;
  drivers: DriverEntry[];
  /** Reserved for RAD-326 docs presets — opaque bag. */
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
  envHostBind: string;
  resendConfigured: boolean;
  envFallbackRecipient: string | null;
  drivers: DriverEntryPublic[];
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

const DEFAULT: RunnerSettings = {
  version: 1,
  configured: false,
  notify: { enabled: false, recipient: null },
  defaultModel: null,
  defaultDriver: "cursor-agent",
  hostBindHint: null,
  drivers: DEFAULT_DRIVERS,
  jobTypes: {},
  presets: {},
};

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

function parseSettings(raw: Partial<RunnerSettings>): RunnerSettings {
  return {
    version: 1,
    configured: Boolean(raw.configured),
    notify: {
      enabled: Boolean(raw.notify?.enabled),
      recipient:
        typeof raw.notify?.recipient === "string" && raw.notify.recipient.trim()
          ? raw.notify.recipient.trim()
          : null,
    },
    defaultModel:
      typeof raw.defaultModel === "string" && raw.defaultModel.trim()
        ? raw.defaultModel.trim()
        : null,
    defaultDriver:
      typeof raw.defaultDriver === "string" && raw.defaultDriver.trim()
        ? raw.defaultDriver.trim()
        : "cursor-agent",
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
        ? (raw.jobTypes as Record<string, unknown>)
        : {},
    presets:
      raw.presets && typeof raw.presets === "object" && !Array.isArray(raw.presets)
        ? (raw.presets as Record<string, unknown>)
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
  notify?: Partial<RunnerSettings["notify"]>;
  defaultModel?: string | null;
  defaultDriver?: string | null;
  hostBindHint?: string | null;
  drivers?: DriverEntry[];
  jobTypes?: Record<string, unknown>;
  presets?: Record<string, unknown>;
};

export async function saveSettings(dataDir: string, patch: SettingsPatch): Promise<RunnerSettings> {
  const current = await loadSettings(dataDir);
  const next = parseSettings({
    ...current,
    configured: patch.configured !== undefined ? Boolean(patch.configured) : true,
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
    defaultModel:
      patch.defaultModel !== undefined ? patch.defaultModel?.trim() || null : current.defaultModel,
    defaultDriver:
      patch.defaultDriver !== undefined
        ? patch.defaultDriver?.trim() || "cursor-agent"
        : current.defaultDriver,
    hostBindHint:
      patch.hostBindHint !== undefined ? patch.hostBindHint?.trim() || null : current.hostBindHint,
    drivers:
      patch.drivers !== undefined ? mergeDrivers(current.drivers, patch.drivers) : current.drivers,
    jobTypes: patch.jobTypes !== undefined ? patch.jobTypes : current.jobTypes,
    presets: patch.presets !== undefined ? patch.presets : current.presets,
  });
  await atomicWriteJson(runnerSettingsFile(dataDir), next);
  return next;
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
    envHostBind: `${config.host}:${config.port}`,
    resendConfigured: Boolean(config.resendApiKey),
    envFallbackRecipient: config.notifyEmail,
    drivers: settings.drivers.map((d) => ({
      id: d.id,
      kind: d.kind,
      binary: d.binary ?? null,
      endpoint: d.endpoint ?? null,
      notes: d.notes ?? null,
      hasApiKey: Boolean(d.apiKey),
      apiKeyMasked: maskSecret(d.apiKey),
    })),
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
