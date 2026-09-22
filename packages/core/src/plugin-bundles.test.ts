import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  PLUGIN_BUNDLE_OUTFILES,
  assertPluginBundlesReady,
  inspectPluginBundles,
} from "./plugin-bundles.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-plugin-bundles-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedLayout(name: string): Promise<string> {
  const root = path.join(dir, name);
  await mkdir(path.join(root, "packages", "cli", "src"), { recursive: true });
  await mkdir(path.join(root, "packages", "core", "src"), { recursive: true });
  await mkdir(path.join(root, "packages", "plugin", "mcp"), { recursive: true });
  await mkdir(path.join(root, "packages", "plugin", "hooks"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "packages", "cli", "src", "mcp-bin.ts"), "export {}\n");
  await writeFile(path.join(root, "packages", "core", "src", "index.ts"), "export {}\n");
  await writeFile(path.join(root, "scripts", "build.mjs"), "// build\n");
  return root;
}

test("inspectPluginBundles fails when server.cjs is missing", async () => {
  const root = await seedLayout("missing");
  const status = await inspectPluginBundles(root);
  assert.equal(status.ok, false);
  assert.ok(status.missing.includes("packages/plugin/mcp/server.cjs"));
  assert.match(status.fix, /pnpm build/);
});

test("inspectPluginBundles fails when a bundle is older than sources", async () => {
  const root = await seedLayout("stale");
  const old = new Date("2020-01-01T00:00:00Z");
  const recent = new Date("2030-01-01T00:00:00Z");

  for (const rel of PLUGIN_BUNDLE_OUTFILES) {
    const abs = path.join(root, rel);
    await writeFile(abs, "/* built */\n");
    await utimes(abs, old, old);
  }
  await utimes(path.join(root, "packages", "cli", "src", "mcp-bin.ts"), recent, recent);

  const status = await inspectPluginBundles(root);
  assert.equal(status.ok, false);
  assert.ok(status.stale.length > 0);
  assert.match(status.summary, /stale/);

  await assert.rejects(
    () => assertPluginBundlesReady(root),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /stale|rebuild|pnpm build/i);
      return true;
    },
  );
});

test("inspectPluginBundles ok when bundles are fresh", async () => {
  const root = await seedLayout("fresh");
  const old = new Date("2020-01-01T00:00:00Z");
  const recent = new Date("2030-01-01T00:00:00Z");

  await utimes(path.join(root, "packages", "cli", "src", "mcp-bin.ts"), old, old);
  await utimes(path.join(root, "packages", "core", "src", "index.ts"), old, old);
  await utimes(path.join(root, "scripts", "build.mjs"), old, old);

  for (const rel of PLUGIN_BUNDLE_OUTFILES) {
    const abs = path.join(root, rel);
    await writeFile(abs, "/* built */\n");
    await utimes(abs, recent, recent);
  }

  const status = await inspectPluginBundles(root);
  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.stale, []);
  await assertPluginBundlesReady(root);
});
