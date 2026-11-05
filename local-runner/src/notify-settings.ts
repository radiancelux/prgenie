import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { notifySettingsFile } from "./paths.js";

export type NotifySettings = {
  enabled: boolean;
  /** Dashboard override; empty uses env fallback when enabled. */
  recipient: string | null;
};

export type NotifySettingsPublic = NotifySettings & {
  envFallbackRecipient: string | null;
  resendConfigured: boolean;
};

const DEFAULT: NotifySettings = {
  enabled: false,
  recipient: null,
};

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function loadNotifySettings(dataDir: string): Promise<NotifySettings> {
  try {
    const raw = await readFile(notifySettingsFile(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<NotifySettings>;
    return {
      enabled: Boolean(parsed.enabled),
      recipient:
        typeof parsed.recipient === "string" && parsed.recipient.trim()
          ? parsed.recipient.trim()
          : null,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export async function saveNotifySettings(
  dataDir: string,
  patch: Partial<NotifySettings>,
): Promise<NotifySettings> {
  const current = await loadNotifySettings(dataDir);
  const next: NotifySettings = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    recipient: patch.recipient !== undefined ? patch.recipient?.trim() || null : current.recipient,
  };
  await atomicWriteJson(notifySettingsFile(dataDir), next);
  return next;
}

export function toPublicNotifySettings(
  config: RunnerConfig,
  settings: NotifySettings,
): NotifySettingsPublic {
  return {
    ...settings,
    envFallbackRecipient: config.notifyEmail,
    resendConfigured: Boolean(config.resendApiKey),
  };
}

/** Resolved recipient when email should send; null when notifications are off or misconfigured. */
export function resolveNotifyRecipient(
  config: RunnerConfig,
  settings: NotifySettings,
): string | null {
  if (!settings.enabled || !config.resendApiKey) return null;
  const to = settings.recipient?.trim() || config.notifyEmail?.trim() || null;
  return to || null;
}
