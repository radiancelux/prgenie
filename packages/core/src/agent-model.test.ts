import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAgentModelFrontmatter, readPluginAgentModel } from "./agent-model.js";

test("parseAgentModelFrontmatter reads model slug", () => {
  const raw = `---
name: prgenie-implementor
model: composer-2.5[fast=false]
---
# body
`;
  assert.equal(parseAgentModelFrontmatter(raw), "composer-2.5[fast=false]");
});

test("readPluginAgentModel loads from PRGENIE_AGENT_HOME user agents dir", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "prgenie-agent-model-"));
  const agentsDir = path.join(fakeHome, ".cursor", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, "prgenie-implementor.md"),
    `---
name: prgenie-implementor
model: test-model[fast=false]
---
`,
    "utf8",
  );
  const prevHome = process.env.PRGENIE_AGENT_HOME;
  process.env.PRGENIE_AGENT_HOME = fakeHome;
  try {
    assert.equal(await readPluginAgentModel("/ignored/repo", "prgenie-implementor"), "test-model[fast=false]");
  } finally {
    if (prevHome === undefined) delete process.env.PRGENIE_AGENT_HOME;
    else process.env.PRGENIE_AGENT_HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});
