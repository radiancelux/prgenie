import type { RunnerSettings } from "./settings.js";
import { git, type GhResult } from "./github.js";

const FALLBACK_REFS = ["origin/main", "origin/master", "main", "master"] as const;

export type ResolvedBaseRef = {
  ref: string;
  source: "preset" | "detected" | "fallback";
};

export function resolveBaseRefFromSettings(settings: RunnerSettings): string | null {
  const v = settings.defaultBaseBranch?.trim();
  if (!v || v.toLowerCase() === "auto") return null;
  return v;
}

/** Ordered probe list for rebase/worktree when auto-detecting. */
export function baseRefProbeOrder(settings: RunnerSettings): string[] {
  const explicit = resolveBaseRefFromSettings(settings);
  if (explicit) return [explicit, ...FALLBACK_REFS.filter((r) => r !== explicit)];
  return [...FALLBACK_REFS];
}

export async function detectDefaultBranch(
  repoPath: string,
  gitImpl: typeof git = git,
): Promise<ResolvedBaseRef | null> {
  const sym = await gitImpl(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0) {
    const m = sym.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) {
      return { ref: `origin/${m[1]}`, source: "detected" };
    }
  }
  const remote = await gitImpl(repoPath, ["remote", "show", "origin"]);
  if (remote.code === 0) {
    const line = remote.stdout.split("\n").find((l) => /HEAD branch:/i.test(l));
    const m = line?.match(/HEAD branch:\s*(\S+)/);
    if (m?.[1]) return { ref: `origin/${m[1]}`, source: "detected" };
  }
  return null;
}

export async function resolveWorktreeBaseRef(
  repoPath: string,
  settings: RunnerSettings,
  gitImpl: typeof git = git,
): Promise<ResolvedBaseRef> {
  const preset = resolveBaseRefFromSettings(settings);
  if (preset) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", preset]);
    if (probe.code === 0) return { ref: preset, source: "preset" };
  }
  const detected = await detectDefaultBranch(repoPath, gitImpl);
  if (detected) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", detected.ref]);
    if (probe.code === 0) return detected;
  }
  for (const ref of FALLBACK_REFS) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", ref]);
    if (probe.code === 0) return { ref, source: "fallback" };
  }
  return { ref: "origin/main", source: "fallback" };
}

export type GitFn = (cwd: string, args: string[]) => Promise<GhResult>;
