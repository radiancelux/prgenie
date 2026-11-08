import type { RunnerConfig } from "./config.js";
import {
  findRepoPreset,
  parseDocsSettings,
  presetToRemote,
  type RepoPreset,
} from "./docs-settings.js";
import { repoSlugFromPath } from "./paths.js";
import type { RunnerSettings } from "./settings.js";
import type { StartJobArgs } from "./types.js";

export type ResolvedJobTarget =
  | {
      ok: true;
      repoPath: string;
      remote?: string;
      repoSlug: string;
      jobType: "code" | "docs" | "compute";
    }
  | { ok: false; error: string };

export function normalizeJobType(args: StartJobArgs): "code" | "docs" | "compute" {
  const profile = args.profile?.trim().toLowerCase();
  const jobType = args.jobType?.trim().toLowerCase();
  if (profile === "docs" || jobType === "docs") return "docs";
  if (profile === "compute" || jobType === "compute") return "compute";
  return "code";
}

function slugFromPreset(preset: RepoPreset): string {
  if (preset.slug?.trim()) return preset.slug.trim();
  if (preset.repoPath?.trim()) return repoSlugFromPath(preset.repoPath);
  const url = preset.url?.trim();
  if (url) {
    const m = url.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (m) return m[1];
  }
  return preset.id;
}

function resolvePresetTarget(
  preset: RepoPreset,
): { repoPath: string; remote?: string; repoSlug: string } | null {
  const repoPath = preset.repoPath?.trim();
  if (repoPath) {
    return {
      repoPath,
      remote: presetToRemote(preset) ?? undefined,
      repoSlug: slugFromPreset(preset),
    };
  }
  const remote = presetToRemote(preset);
  if (remote) {
    return { repoPath: "", remote, repoSlug: slugFromPreset(preset) };
  }
  return null;
}

export function resolveJobTarget(
  args: StartJobArgs,
  settings: RunnerSettings,
  config: Pick<RunnerConfig, "defaultCodeRepoPath">,
): ResolvedJobTarget {
  const jobType = normalizeJobType(args);
  const explicitPath = args.repoPath?.trim();
  const explicitRemote = args.remote?.trim();

  if (explicitPath || explicitRemote) {
    const repoPath = explicitPath || "";
    const slug = explicitPath
      ? repoSlugFromPath(explicitPath)
      : (explicitRemote!.match(/github\.com\/([^/]+\/[^/]+)/i)?.[1] ?? "remote");
    return {
      ok: true,
      repoPath,
      remote: explicitRemote || undefined,
      repoSlug: slug,
      jobType,
    };
  }

  const docs = parseDocsSettings(settings);
  const presetId = jobType === "docs" ? docs.defaultPresetId.docs : docs.defaultPresetId.code;
  const preset = findRepoPreset(docs.repoPresets, presetId);
  if (preset) {
    const resolved = resolvePresetTarget(preset);
    if (resolved) {
      return { ok: true, ...resolved, jobType };
    }
    return { ok: false, error: `Preset "${preset.name}" has no local path or GitHub slug` };
  }

  if (jobType === "code" && config.defaultCodeRepoPath?.trim()) {
    const repoPath = config.defaultCodeRepoPath.trim();
    return { ok: true, repoPath, repoSlug: repoSlugFromPath(repoPath), jobType };
  }

  if (jobType === "docs") {
    return {
      ok: false,
      error: "Docs jobs need a target repo — set a default on Setup or pass repoPath / remote",
    };
  }

  return {
    ok: false,
    error: "repoPath or remote required (or configure a code default repo in Setup)",
  };
}
