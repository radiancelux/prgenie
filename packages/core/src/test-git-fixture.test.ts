import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { git } from "./git.js";
import {
  FIXTURE_TEMPLATE_SCHEMA,
  FIXTURE_USER_EMAIL,
  FIXTURE_USER_NAME,
  clearGitFixtureTemplatesForTest,
  createTempGitRepo,
  ensureGitFixtureTemplate,
  getGitFixtureTemplatePathForTest,
  removeGitFixtureTemplatesSyncForTest,
} from "./test-git-fixture.js";

describe("test-git-fixture", () => {
  it("reuses the process-local template on cache hit", async () => {
    clearGitFixtureTemplatesForTest();
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

  it("clone is init-equivalent: local identity, no origin, commits succeed", async () => {
    clearGitFixtureTemplatesForTest();
    const repo = await createTempGitRepo({ prefix: "prgenie-fixture-ident-" });
    try {
      const email = await git(repo, ["config", "user.email"]);
      const name = await git(repo, ["config", "user.name"]);
      assert.equal(email.stdout.trim(), FIXTURE_USER_EMAIL);
      assert.equal(name.stdout.trim(), FIXTURE_USER_NAME);
      const remotes = await git(repo, ["remote"], { allowFail: true });
      assert.equal(remotes.stdout.trim(), "");
      const upstream = await git(repo, ["config", "--get", "branch.main.remote"], {
        allowFail: true,
      });
      assert.notEqual(upstream.code, 0, "branch.main should not track a remote");
      await writeFile(join(repo, "probe.txt"), "x\n");
      await git(repo, ["add", "probe.txt"]);
      await git(repo, ["commit", "-m", "probe"]);
      const log = await git(repo, ["log", "-1", "--format=%ae %an"]);
      assert.equal(log.stdout.trim(), `${FIXTURE_USER_EMAIL} ${FIXTURE_USER_NAME}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("sync cleanup removes template directories from disk", async () => {
    clearGitFixtureTemplatesForTest();
    const path = await ensureGitFixtureTemplate("basic");
    assert.ok(existsSync(path));
    removeGitFixtureTemplatesSyncForTest();
    assert.equal(existsSync(path), false);
    assert.equal(getGitFixtureTemplatePathForTest("basic"), undefined);
  });

  it("rebuilds the template when schema version mismatches", async () => {
    clearGitFixtureTemplatesForTest();
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
