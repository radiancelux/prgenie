import type { RunnerConfig } from "./config.js";
import {
  findDriverEntry,
  loadSettings,
  resolveDefaultDriverId,
  resolveDefaultModel,
  saveSettings,
  toPublicSettings,
  type RunnerSettings,
} from "./settings.js";

export type NotifySettings = {
  enabled: boolean;
  /** Dashboard override; empty uses env fallback when enabled. */
  recipient: string | null;
};

export type NotifySettingsPublic = NotifySettings & {
  envFallbackRecipient: string | null;
  resendConfigured: boolean;
};

function notifyFromSettings(s: RunnerSettings): NotifySettings {
  return { enabled: s.notify.enabled, recipient: s.notify.recipient };
}

export async function loadNotifySettings(dataDir: string): Promise<NotifySettings> {
  return notifyFromSettings(await loadSettings(dataDir));
}

export async function saveNotifySettings(
  dataDir: string,
  patch: Partial<NotifySettings>,
): Promise<NotifySettings> {
  const saved = await saveSettings(dataDir, {
    notify: {
      enabled: patch.enabled,
      recipient: patch.recipient,
    },
  });
  return notifyFromSettings(saved);
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

export {
  loadSettings,
  saveSettings,
  toPublicSettings,
  resolveDefaultModel,
  resolveDefaultDriverId,
  findDriverEntry,
};
