import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { git } from "./git.js";
import {
  FIXTURE_TEMPLATE_SCHEMA,
  clearGitFixtureTemplatesForTest,
  createTempGitRepo,
  ensureGitFixtureTemplate,
  getGitFixtureTemplatePathForTest,
} from "./test-git-fixture.js";

afterEach(() => {
  clearGitFixtureTemplatesForTest();
});

describe("test-git-fixture", () => {
  it("reuses the process-local template on cache hit", async () => {
    const first = await createTempGitRepo({ prefix: "prgenie-fixture-hit-a-" });
    const tplAfterFirst = getGitFixtureTemplatePathForTest("basic");
    assert.ok(tplAfterFirst);
    try {
      const second = await createTempGitRepo({ prefix: "prgenie-fixture-hit-b-" });
      try {
        assert.equal(getGitFixtureTemplatePathForTest("basic"), tplAfterFirst);
        const log1 = await git(first, ["rev-parse", "HEAD"]);
        const log2 = await git(second, ["rev-parse", "HEAD"]);
        assert.equal(log1.stdout.trim(), log2.stdout.trim());
        assert.notEqual(first, second);
      } finally {
        await rm(second, { recursive: true, force: true });
      }
    } finally {
      await rm(first, { recursive: true, force: true });
    }
  });

  it("rebuilds the template when schema version mismatches", async () => {
    await ensureGitFixtureTemplate("basic");
    const before = getGitFixtureTemplatePathForTest("basic");
    assert.ok(before);
    await writeFile(
      join(before!, ".prgenie-git-fixture-schema"),
      String(FIXTURE_TEMPLATE_SCHEMA + 1),
    );

    const repo = await createTempGitRepo({ prefix: "prgenie-fixture-schema-" });
    try {
      const after = getGitFixtureTemplatePathForTest("basic");
      assert.ok(after);
      assert.notEqual(after, before);
      const schema = await readFile(join(after!, ".prgenie-git-fixture-schema"), "utf8");
      assert.equal(Number.parseInt(schema.trim(), 10), FIXTURE_TEMPLATE_SCHEMA);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
