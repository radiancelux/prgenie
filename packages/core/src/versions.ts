import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export interface PackageVersionEntry {
  id: string;
  file: string;
  version: string;
}

export interface VsixArtifactInfo {
  file: string;
  fileName: string;
  versionFromName: string | null;
  versionFromManifest: string | null;
}

export interface ReleaseVersionReport {
  ok: boolean;
  expectedVersion: string | null;
  packages: PackageVersionEntry[];
  skew: string[];
  vsix: VsixArtifactInfo[];
  summary: string;
  fix?: string;
}

export interface CollectPackageVersionsResult {
  packages: PackageVersionEntry[];
  /** Fail-closed issues (missing path or non-string/empty version), matching check-versions.mjs. */
  issues: string[];
}

/** Package.json paths relative to the monorepo root that must share one version. */
export const RELEASE_PACKAGE_PATHS = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/extension/package.json",
  "packages/plugin/package.json",
] as const;

export function findPackageRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "packages", "plugin", "package.json"))) return dir;
    if (existsSync(path.join(dir, "packages", "extension", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function versionFromVsixFileName(fileName: string): string | null {
  const m = /^prgenie-(.+)\.vsix$/i.exec(fileName);
  return m ? m[1] : null;
}

async function readPackageVersion(file: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

/** Minimal ZIP local-file extractor (store + deflate). */
function extractZipEntry(buf: Buffer, entryName: string): Buffer | null {
  let offset = 0;
  while (offset + 30 < buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) return null;
    if (name === entryName) {
      const data = buf.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    offset = dataEnd;
  }
  return null;
}

/** Read extension/package.json version from a .vsix (zip) without external deps. */
export async function readVersionFromVsix(vsixPath: string): Promise<string | null> {
  try {
    const buf = await readFile(vsixPath);
    const entry = extractZipEntry(buf, "extension/package.json");
    if (!entry) return null;
    const pkg = JSON.parse(entry.toString("utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Collect release package versions. Fail-closed: missing paths and non-string/empty
 * versions are reported in `issues` (same invariant as scripts/check-versions.mjs).
 */
export async function collectPackageVersions(
  packageRoot: string,
): Promise<CollectPackageVersionsResult> {
  const packages: PackageVersionEntry[] = [];
  const issues: string[] = [];
  for (const rel of RELEASE_PACKAGE_PATHS) {
    const file = path.join(packageRoot, rel);
    if (!existsSync(file)) {
      issues.push(`missing ${rel}`);
      continue;
    }
    const version = await readPackageVersion(file);
    if (!version) {
      issues.push(`${rel} has no string version`);
      continue;
    }
    packages.push({ id: rel, file, version });
  }
  return { packages, issues };
}

export async function collectVsixArtifacts(packageRoot: string): Promise<VsixArtifactInfo[]> {
  const dir = path.join(packageRoot, "packages", "extension");
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: VsixArtifactInfo[] = [];
  for (const fileName of names) {
    if (!/^prgenie-.+\.vsix$/i.test(fileName)) continue;
    const file = path.join(dir, fileName);
    out.push({
      file,
      fileName,
      versionFromName: versionFromVsixFileName(fileName),
      versionFromManifest: await readVersionFromVsix(file),
    });
  }
  return out;
}

export async function checkReleaseVersions(packageRoot: string): Promise<ReleaseVersionReport> {
  const { packages, issues } = await collectPackageVersions(packageRoot);
  const vsix = await collectVsixArtifacts(packageRoot);
  const skew: string[] = [...issues];
  const expectedVersion =
    packages.find((p) => p.id === "packages/extension/package.json")?.version ??
    packages[0]?.version ??
    null;

  if (!expectedVersion) {
    return {
      ok: false,
      expectedVersion: null,
      packages,
      skew: skew.length ? skew : ["No package.json versions found under the monorepo."],
      vsix,
      summary: skew.length
        ? `Release version skew: ${skew.join("; ")}`
        : "Could not read monorepo package versions.",
      fix: "Ensure package.json files exist under the repo root and packages/* with string versions.",
    };
  }

  for (const pkg of packages) {
    if (pkg.version !== expectedVersion) {
      skew.push(`${pkg.id} is ${pkg.version} (expected ${expectedVersion})`);
    }
  }

  for (const art of vsix) {
    if (art.versionFromName && art.versionFromName !== expectedVersion) {
      skew.push(`${art.fileName} name is ${art.versionFromName} (expected ${expectedVersion})`);
    }
    if (art.versionFromManifest && art.versionFromManifest !== expectedVersion) {
      skew.push(`${art.fileName} embeds ${art.versionFromManifest} (expected ${expectedVersion})`);
    }
    if (
      art.versionFromName &&
      art.versionFromManifest &&
      art.versionFromName !== art.versionFromManifest
    ) {
      skew.push(
        `${art.fileName} name/manifest mismatch (${art.versionFromName} vs ${art.versionFromManifest})`,
      );
    }
  }

  const ok = skew.length === 0;
  const vsixNote =
    vsix.length === 0 ? "no local prgenie-*.vsix" : vsix.map((v) => v.fileName).join(", ");
  return {
    ok,
    expectedVersion,
    packages,
    skew,
    vsix,
    summary: ok
      ? `Package versions aligned at ${expectedVersion} (${vsixNote}).`
      : `Release version skew: ${skew.join("; ")}`,
    fix: ok
      ? undefined
      : "Align root + packages/*/package.json to one version, then pnpm build && pnpm pack:extension (see docs/release.md).",
  };
}
