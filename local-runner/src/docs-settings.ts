import type { RunnerSettings } from "./settings.js";

export type DocsTemplateId = "marketing" | "policy" | "research";

export type RepoPreset = {
  id: string;
  name: string;
  /** GitHub owner/repo */
  slug?: string | null;
  /** Local clone on the runner host (preferred for v1) */
  repoPath?: string | null;
  /** Optional https://github.com/owner/repo.git */
  url?: string | null;
};

export type DocChecksConfig = {
  enabled: boolean;
  failHard: boolean;
};

export type ParsedDocsSettings = {
  repoPresets: RepoPreset[];
  defaultPresetId: { code: string | null; docs: string | null };
  docChecks: DocChecksConfig;
};

const DEFAULT_DOC_CHECKS: DocChecksConfig = { enabled: true, failHard: false };

function normPreset(raw: unknown): RepoPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!id || !name) return null;
  return {
    id,
    name,
    slug: typeof o.slug === "string" && o.slug.trim() ? o.slug.trim() : null,
    repoPath: typeof o.repoPath === "string" && o.repoPath.trim() ? o.repoPath.trim() : null,
    url: typeof o.url === "string" && o.url.trim() ? o.url.trim() : null,
  };
}

export function parseDocsSettings(settings: RunnerSettings): ParsedDocsSettings {
  const presetsBag = settings.presets;
  let repoPresets: RepoPreset[] = [];
  if (presetsBag && typeof presetsBag === "object" && !Array.isArray(presetsBag)) {
    const repos = (presetsBag as Record<string, unknown>).repos;
    if (Array.isArray(repos)) {
      repoPresets = repos.map(normPreset).filter((p): p is RepoPreset => p != null);
    }
  }

  const jobBag = settings.jobTypes;
  let defaultPresetId = { code: null as string | null, docs: null as string | null };
  let docChecks = { ...DEFAULT_DOC_CHECKS };

  if (jobBag && typeof jobBag === "object" && !Array.isArray(jobBag)) {
    const bag = jobBag as Record<string, unknown>;
    const d = bag.defaultPresetId;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const o = d as Record<string, unknown>;
      defaultPresetId = {
        code: typeof o.code === "string" && o.code.trim() ? o.code.trim() : null,
        docs: typeof o.docs === "string" && o.docs.trim() ? o.docs.trim() : null,
      };
    }
    const dc = bag.docChecks;
    if (dc && typeof dc === "object" && !Array.isArray(dc)) {
      const o = dc as Record<string, unknown>;
      docChecks = {
        enabled: o.enabled !== false,
        failHard: Boolean(o.failHard),
      };
    }
  }

  return { repoPresets, defaultPresetId, docChecks };
}

export function findRepoPreset(
  presets: RepoPreset[],
  id: string | null | undefined,
): RepoPreset | null {
  if (!id?.trim()) return null;
  return presets.find((p) => p.id === id.trim()) ?? null;
}

export function presetToRemote(preset: RepoPreset): string | null {
  if (preset.url?.trim()) return preset.url.trim();
  if (preset.slug?.trim()) {
    const slug = preset.slug.trim();
    if (slug.includes("/")) return `https://github.com/${slug}.git`;
  }
  return null;
}

export function presetDisplayLabel(preset: RepoPreset): string {
  if (preset.slug) return `${preset.name} (${preset.slug})`;
  if (preset.repoPath) return `${preset.name} (${preset.repoPath})`;
  return preset.name;
}

export function serializeDocsSettingsPatch(parsed: ParsedDocsSettings): {
  presets: Record<string, unknown>;
  jobTypes: Record<string, unknown>;
} {
  return {
    presets: { repos: parsed.repoPresets },
    jobTypes: {
      defaultPresetId: parsed.defaultPresetId,
      docChecks: parsed.docChecks,
    },
  };
}
