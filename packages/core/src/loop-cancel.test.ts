import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createTempGitRepo } from "./test-git-fixture.js";
import {
  assertLoopNotCancelled,
  clearLoopCancel,
  loopCancelFile,
  readLoopCancel,
  writeLoopCancel,
} from "./loop-cancel.js";

describe("loop-cancel marker", () => {
  it("RAD-139: write, read and clear the cancel marker", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-loop-cancel-" });
    try {
      const id = "lp-test01";
      assert.equal(readLoopCancel(repo, id), null);
      assert.doesNotThrow(() => clearLoopCancel(repo, id));

      await writeLoopCancel(repo, id, {
        cancelledBy: "human",
        source: "panel",
        implementorTaskId: "task-1",
      });
      const file = loopCancelFile(repo, id);
      assert.ok(file.includes("loop-cancel"));
      const marker = readLoopCancel(repo, id);
      assert.ok(marker);
      assert.equal(marker.id, id);
      assert.match(marker.cancelledAt ?? "", /^\d{4}-/);
      assert.equal(marker.implementorTaskId, "task-1");

      assert.throws(() => assertLoopNotCancelled(repo, id), /Loop cancelled from panel at/);

      clearLoopCancel(repo, id);
      assert.equal(readLoopCancel(repo, id), null);
      assert.doesNotThrow(() => assertLoopNotCancelled(repo, id));

      await mkdir(file.replace(/[^/\\]+$/, ""), { recursive: true });
      await writeFile(file, "{ not json\n", "utf8");
      const corrupt = readLoopCancel(repo, id);
      assert.ok(corrupt);
      assert.equal(corrupt.cancelledAt, null);
      assert.throws(() => assertLoopNotCancelled(repo, id));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
