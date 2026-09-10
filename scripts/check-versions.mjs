import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PATHS = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/extension/package.json",
  "packages/plugin/package.json",
];

function versionFromVsixFileName(fileName) {
  const m = /^prgenie-(.+)\.vsix$/i.exec(fileName);
  return m ? m[1] : null;
}

function extractZipEntry(buf, entryName) {
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

async function readVsixVersion(vsixPath) {
  try {
    const buf = await readFile(vsixPath);
    const entry = extractZipEntry(buf, "extension/package.json");
    if (!entry) return null;
    const pkg = JSON.parse(entry.toString("utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

const skew = [];
const packages = [];
for (const rel of PATHS) {
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    skew.push(`missing ${rel}`);
    continue;
  }
  const pkg = JSON.parse(await readFile(file, "utf8"));
  packages.push({ id: rel, version: pkg.version });
  console.log(`  ${String(pkg.version).padEnd(8)} ${rel}`);
}

const expected =
  packages.find((p) => p.id === "packages/extension/package.json")?.version ?? packages[0]?.version;
if (!expected) {
  console.error("FAIL  no package versions found");
  process.exit(1);
}
for (const p of packages) {
  if (p.version !== expected) skew.push(`${p.id} is ${p.version} (expected ${expected})`);
}

const extDir = path.join(root, "packages", "extension");
if (existsSync(extDir)) {
  for (const fileName of await readdir(extDir)) {
    if (!/^prgenie-.+\.vsix$/i.test(fileName)) continue;
    const fromName = versionFromVsixFileName(fileName);
    const fromManifest = await readVsixVersion(path.join(extDir, fileName));
    console.log(`  vsix     ${fileName} name=${fromName ?? "?"} manifest=${fromManifest ?? "?"}`);
    if (fromName && fromName !== expected)
      skew.push(`${fileName} name is ${fromName} (expected ${expected})`);
    if (fromManifest && fromManifest !== expected) {
      skew.push(`${fileName} embeds ${fromManifest} (expected ${expected})`);
    }
  }
}

if (skew.length) {
  console.error(`FAIL  Release version skew: ${skew.join("; ")}`);
  console.error(
    "      fix: Align package.json versions, then pnpm build && pnpm pack:extension (docs/release.md).",
  );
  process.exit(1);
}
console.log(`ok    Package versions aligned at ${expected}.`);
