import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseAgentModelFrontmatter, readPluginAgentModel } from "./agent-model.js";

let repo = "";

after(async () => {
  if (repo) {
    const { rm } = await import("node:fs/promises");
    await rm(repo, { recursive: true, force: true });
  }
});

test("parseAgentModelFrontmatter reads model slug", () => {
  const raw = `---
name: prgenie-implementor
model: composer-2.5[fast=false]
---
# body
`;
  assert.equal(parseAgentModelFrontmatter(raw), "composer-2.5[fast=false]");
});

test("readPluginAgentModel loads from packages/plugin/agents", async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-agent-model-"));
  const dir = path.join(repo, "packages", "plugin", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "prgenie-implementor.md"),
    `---
name: prgenie-implementor
model: test-model[fast=false]
---
`,
    "utf8",
  );
  assert.equal(await readPluginAgentModel(repo, "prgenie-implementor"), "test-model[fast=false]");
});
