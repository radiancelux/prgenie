import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  checkReleaseVersions,
  collectPackageVersions,
  versionFromVsixFileName,
} from "./versions.js";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function zipOne(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-versions-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("versionFromVsixFileName parses prgenie-<ver>.vsix", () => {
  assert.equal(versionFromVsixFileName("prgenie-0.1.1.vsix"), "0.1.1");
  assert.equal(versionFromVsixFileName("other.vsix"), null);
});

test("checkReleaseVersions passes when all package.json versions match", async () => {
  const root = path.join(dir, "aligned");
  await mkdir(path.join(root, "packages", "core"), { recursive: true });
  await mkdir(path.join(root, "packages", "cli"), { recursive: true });
  await mkdir(path.join(root, "packages", "extension"), { recursive: true });
  await mkdir(path.join(root, "packages", "plugin"), { recursive: true });
  for (const rel of [
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/extension/package.json",
    "packages/plugin/package.json",
  ]) {
    await writeFile(path.join(root, rel), JSON.stringify({ name: rel, version: "0.1.1" }), "utf8");
  }
  const report = await checkReleaseVersions(root);
  assert.equal(report.ok, true);
  assert.equal(report.expectedVersion, "0.1.1");
  assert.equal(report.skew.length, 0);
});

test("checkReleaseVersions fails on package skew and lagging VSIX", async () => {
  const root = path.join(dir, "skewed");
  await mkdir(path.join(root, "packages", "core"), { recursive: true });
  await mkdir(path.join(root, "packages", "cli"), { recursive: true });
  await mkdir(path.join(root, "packages", "extension"), { recursive: true });
  await mkdir(path.join(root, "packages", "plugin"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  await writeFile(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({ version: "0.1.0" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/cli/package.json"),
    JSON.stringify({ version: "0.1.0" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/extension/package.json"),
    JSON.stringify({ version: "0.1.1" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/plugin/package.json"),
    JSON.stringify({ version: "0.1.1" }),
    "utf8",
  );
  const embedded = Buffer.from(JSON.stringify({ version: "0.1.0" }), "utf8");
  await writeFile(
    path.join(root, "packages/extension/prgenie-0.1.0.vsix"),
    zipOne("extension/package.json", embedded),
  );
  const report = await checkReleaseVersions(root);
  assert.equal(report.ok, false);
  assert.equal(report.expectedVersion, "0.1.1");
  assert.ok(report.skew.some((s) => s.includes("package.json is 0.1.0")));
  assert.ok(report.skew.some((s) => /prgenie-0\.1\.0\.vsix/.test(s)));
});

test("collectPackageVersions / checkReleaseVersions fail-closed on missing or version-less package.json", async () => {
  const root = path.join(dir, "incomplete");
  await mkdir(path.join(root, "packages", "core"), { recursive: true });
  await mkdir(path.join(root, "packages", "cli"), { recursive: true });
  await mkdir(path.join(root, "packages", "extension"), { recursive: true });
  // Intentionally omit packages/plugin/package.json (matches check-versions.mjs missing path).
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.1" }), "utf8");
  await writeFile(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({ version: "0.1.1" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/cli/package.json"),
    JSON.stringify({ name: "cli" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/extension/package.json"),
    JSON.stringify({ version: "" }),
    "utf8",
  );

  const collected = await collectPackageVersions(root);
  assert.ok(collected.issues.some((s) => s === "missing packages/plugin/package.json"));
  assert.ok(collected.issues.some((s) => s.includes("packages/cli/package.json")));
  assert.ok(collected.issues.some((s) => s.includes("packages/extension/package.json")));
  assert.equal(collected.packages.length, 2);

  const report = await checkReleaseVersions(root);
  assert.equal(report.ok, false);
  assert.ok(report.skew.some((s) => s === "missing packages/plugin/package.json"));
  assert.ok(report.skew.some((s) => /packages\/cli\/package\.json has no string version/.test(s)));
  assert.ok(
    report.skew.some((s) => /packages\/extension\/package\.json has no string version/.test(s)),
  );
});
