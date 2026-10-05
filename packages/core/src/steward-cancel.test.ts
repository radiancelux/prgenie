import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "node:test";
import { clearLoopCancel, readLoopCancel, writeLoopCancel } from "./loop-cancel.js";
import { createLocalPr, setLocalPrStatus } from "./prs.js";
import { bindSteward, stewardNext } from "./steward.js";
import { createTempGitRepo } from "./test-git-fixture.js";

describe("steward_next cancel marker", () => {
  it("RAD-139: steward_next returns cancelled for a cancelled loop", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-steward-cancel-" });
    try {
      const pr = await createLocalPr(repo, { title: "cancelled loop", base: "main" });
      await bindSteward(repo, pr.id, { implementorTaskId: "impl-task-1" });
      await writeLoopCancel(repo, pr.id, {
        cancelledBy: "human",
        source: "panel",
        implementorTaskId: "impl-task-1",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");
      const withTask = await stewardNext(repo, pr.id, { evaluateGate: true });
      assert.equal(withTask.decision.kind, "cancelled");
      assert.match(withTask.decision.reason, /cancelled from panel at/);
      assert.match(withTask.decision.reason, /impl-task-1/);
      assert.match(withTask.decision.reason, /Do not spawn or resume/);

      await bindSteward(repo, pr.id, { implementorTaskId: null });
      clearLoopCancel(repo, pr.id);
      await writeLoopCancel(repo, pr.id, {
        cancelledBy: "human",
        source: "panel",
        implementorTaskId: null,
      });
      const alone = await stewardNext(repo, pr.id, { evaluateGate: false });
      assert.equal(alone.decision.kind, "cancelled");
      assert.doesNotMatch(alone.decision.reason, /Stop implementor Task/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-139: restart clears the cancel marker", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-steward-restart-" });
    try {
      const pr = await createLocalPr(repo, { title: "restart clear", base: "main" });
      await writeLoopCancel(repo, pr.id, {
        cancelledBy: "human",
        source: "panel",
        implementorTaskId: null,
      });
      const next = await stewardNext(repo, pr.id, { restart: true, evaluateGate: false });
      assert.notEqual(next.decision.kind, "cancelled");
      const again = await stewardNext(repo, pr.id, { evaluateGate: false });
      assert.notEqual(again.decision.kind, "cancelled");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-139: steward_next resolves a loop id prefix for the cancel marker", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-steward-prefix-" });
    try {
      const pr = await createLocalPr(repo, { title: "prefix cancel", base: "main" });
      const prefix = pr.id.slice(0, -2);
      await writeLoopCancel(repo, pr.id, {
        cancelledBy: "human",
        source: "panel",
        implementorTaskId: null,
      });
      const cancelled = await stewardNext(repo, prefix, { evaluateGate: false });
      assert.equal(cancelled.decision.kind, "cancelled");
      assert.equal(cancelled.decision.loopId, pr.id);

      const restarted = await stewardNext(repo, prefix, { restart: true, evaluateGate: false });
      assert.notEqual(restarted.decision.kind, "cancelled");
      assert.equal(readLoopCancel(repo, pr.id), null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
