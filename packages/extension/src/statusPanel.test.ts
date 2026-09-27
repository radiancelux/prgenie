import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  STATUS_PANEL_TITLE,
  decideStatusPanelPaint,
  exportBusyHelper,
  statusPanelGuidanceForLoop,
  statusPanelIdleBody,
  type StatusPanelPaintInput,
} from "./statusPanel.js";

const laneViewSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
  "utf8",
);

function injectedDecide(): typeof decideStatusPanelPaint {
  return new Function(
    `return (${decideStatusPanelPaint.toString()})`,
  )() as typeof decideStatusPanelPaint;
}

describe("STATUS panel copy (RAD-110)", () => {
  it("renames the section to STATUS", () => {
    assert.equal(STATUS_PANEL_TITLE, "STATUS");
    assert.equal(/<span class="label">EXPORT<\/span>/.test(laneViewSrc), false);
    assert.equal(laneViewSrc.includes("Not ready for review. Implement in the worktree"), false);
    assert.equal(laneViewSrc.includes("Ready for review. Waiting on the reviewer"), false);
    assert.equal(
      laneViewSrc.includes("Select a live loop to see draft, review, CI, or export status."),
      false,
    );
  });

  it("clears idle body without leftover READY/FAIL gate language", () => {
    assert.match(statusPanelIdleBody({}), /No loops yet/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /Expand Archive/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /Clear archived/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /remotes stay/i);
    assert.match(statusPanelIdleBody({ searchQuery: "foo" }), /No matching loops/);
    assert.equal(/READY|FAIL|BLOCKED/.test(statusPanelIdleBody({ archivedCount: 1 })), false);
  });

  it("gives phase-correct draft/ready guidance, not export-blocked copy", () => {
    const draft = statusPanelGuidanceForLoop("draft");
    assert.equal(draft.badge, "DRAFT");
    assert.match(draft.body, /Not ready for review/i);
    assert.equal(/EXPORT BLOCKED|FAIL/.test(draft.body), false);

    const ready = statusPanelGuidanceForLoop("ready");
    assert.equal(ready.badge, "READY");
    assert.match(ready.body, /not an export gate/i);

    const archived = statusPanelGuidanceForLoop("approved");
    assert.equal(archived.badge, "ARCHIVED");
    assert.match(archived.body, /Read-only/i);
  });
});

describe("export busy helper (RAD-124)", () => {
  it("names the active step when Open on GitHub is disabled", () => {
    assert.equal(exportBusyHelper("Pushing"), "Open on GitHub unavailable — Pushing");
    assert.match(exportBusyHelper(undefined), /export in progress/);
  });
});

describe("decideStatusPanelPaint (RAD-110)", () => {
  const loop = (status: string, id = "lp-a") => ({ id, status });

  it("RAD-110: decideStatusPanelPaint is self-contained and injectable", () => {
    const injected = injectedDecide();
    const matrix: StatusPanelPaintInput[] = [
      { liveCount: 0, selected: null, progress: null, shepherd: null },
      {
        liveCount: 0,
        archivedCount: 2,
        selected: null,
        progress: null,
        shepherd: null,
      },
      { liveCount: 2, selected: null, progress: null, shepherd: null },
      {
        liveCount: 1,
        selected: loop("draft"),
        progress: { id: "lp-a", step: "x" },
        shepherd: { status: "blocked", reasons: [{ check: "ci", message: "fail" }] },
      },
      {
        liveCount: 1,
        selected: loop("reviewed"),
        progress: { id: "lp-other", step: "foreign" },
        shepherd: null,
      },
      {
        liveCount: 1,
        selected: loop("reviewed"),
        progress: { id: "lp-a", step: "Gate CI" },
        shepherd: null,
      },
      {
        liveCount: 1,
        selected: loop("reviewed"),
        progress: null,
        shepherd: {
          status: "blocked",
          reasons: [{ check: "ci", message: "CI check failed: lint" }],
        },
      },
      {
        liveCount: 1,
        selected: { ...loop("reviewed"), humanKind: "pending", humanHint: "Waiting on you" },
        progress: null,
        shepherd: null,
      },
    ];
    for (const row of matrix) {
      assert.deepEqual(injected(row), decideStatusPanelPaint(row));
    }
  });

  it("RAD-110: idle with no live loops never shows reasons or CI card", () => {
    const d = decideStatusPanelPaint({
      liveCount: 0,
      selected: null,
      progress: null,
      shepherd: { status: "blocked", reasons: [{ check: "ci", message: "stale" }] },
    });
    assert.equal(d.mode, "quiet");
    assert.equal(d.badge, "IDLE");
    assert.equal(d.showReasons, false);
    assert.equal(d.showCiCard, false);
    assert.equal(d.showProgress, false);
    assert.equal(d.body, statusPanelIdleBody({}));
  });

  it("RAD-110: no selection shows select-a-loop copy", () => {
    const d = decideStatusPanelPaint({
      liveCount: 3,
      selected: null,
      progress: { id: "lp-x", step: "ignored" },
      shepherd: { status: "blocked", reasons: [] },
    });
    assert.equal(d.mode, "quiet");
    assert.equal(d.badge, "—");
    assert.match(d.body, /Select a live loop/);
    assert.equal(d.showProgress, false);
  });

  it("RAD-110: pre-reviewed loops stay quiet even with matching progress and blocked shepherd", () => {
    const noisy = {
      progress: { id: "lp-a", step: "export" },
      shepherd: {
        status: "blocked" as const,
        reasons: [{ check: "ci", message: "FAIL something" }],
      },
    };
    for (const status of ["draft", "ready", "review_interrupted", "changes_requested"] as const) {
      const d = decideStatusPanelPaint({
        liveCount: 1,
        selected: loop(status),
        progress: noisy.progress,
        shepherd: noisy.shepherd,
      });
      assert.equal(d.mode, "quiet", status);
      assert.equal(d.showReasons, false, status);
      assert.equal(d.showProgress, false, status);
      assert.equal(d.showCiCard, false, status);
      const expected = statusPanelGuidanceForLoop(status);
      assert.equal(d.badge, expected.badge, status);
      assert.equal(d.body, expected.body, status);
      assert.equal(/EXPORT|BLOCKED|FAIL/.test(d.body), false, status);
      assert.equal(d.body.includes("Status is draft (not ready for review)"), false, status);
    }
  });

  it("RAD-110: archived loop is quiet ARCHIVED", () => {
    const d = decideStatusPanelPaint({
      liveCount: 0,
      selected: loop("approved"),
      progress: { id: "lp-a", step: "x" },
      shepherd: { status: "blocked", reasons: [{ check: "ci", message: "fail" }] },
    });
    assert.equal(d.mode, "quiet");
    assert.equal(d.badge, "ARCHIVED");
    assert.equal(d.body, statusPanelGuidanceForLoop("approved").body);
    assert.equal(d.showReasons, false);
  });

  it("RAD-110: reviewed loop shows only its own progress", () => {
    const d = decideStatusPanelPaint({
      liveCount: 1,
      selected: loop("reviewed"),
      progress: { id: "lp-other", step: "foreign step" },
      shepherd: null,
    });
    assert.notEqual(d.showProgress, true);
    assert.notEqual(d.progressStep, "foreign step");

    const own = decideStatusPanelPaint({
      liveCount: 1,
      selected: loop("reviewed"),
      progress: { id: "lp-a", step: "Running lint" },
      shepherd: null,
    });
    assert.equal(own.mode, "gate");
    assert.equal(own.showProgress, true);
    assert.equal(own.progressStep, "Running lint");
  });

  it("RAD-110: reviewed loop without gate result shows pending hint", () => {
    const d = decideStatusPanelPaint({
      liveCount: 1,
      selected: { id: "lp-a", status: "reviewed", humanKind: "pending", humanHint: "Custom hint" },
      progress: null,
      shepherd: null,
    });
    assert.equal(d.mode, "quiet");
    assert.equal(d.badge, "PENDING");
    assert.equal(d.body, "Custom hint");
  });

  it("RAD-110: reviewed blocked loop shows reasons", () => {
    const d = decideStatusPanelPaint({
      liveCount: 1,
      selected: loop("reviewed"),
      progress: null,
      shepherd: {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: lint" }],
      },
    });
    assert.equal(d.mode, "gate");
    assert.equal(d.badge, "blocked");
    assert.equal(d.showReasons, true);
  });

  it("RAD-110: laneView paintShepherd uses the injected decision", () => {
    assert.match(laneViewSrc, /decideStatusPanelPaint\.toString\(\)/);
    assert.match(laneViewSrc, /decideStatusPanelPaint\(paintInput\)/);
    assert.equal(
      /selected\.status !== "reviewed" && !progress/.test(laneViewSrc),
      false,
      "paintShepherd must not branch on selected.status !== reviewed",
    );
  });

  it("RAD-110: switching from a blocked reviewed loop to zero loops clears to idle", () => {
    const blocked = decideStatusPanelPaint({
      liveCount: 1,
      selected: loop("reviewed"),
      progress: null,
      shepherd: { status: "blocked", reasons: [{ check: "ci", message: "fail" }] },
    });
    assert.equal(blocked.showReasons, true);

    const idle = decideStatusPanelPaint({
      liveCount: 0,
      selected: null,
      progress: null,
      shepherd: { status: "blocked", reasons: [{ check: "ci", message: "stale" }] },
    });
    assert.equal(idle.mode, "quiet");
    assert.equal(idle.badge, "IDLE");
    assert.equal(idle.showReasons, false);
  });

  it("RAD-110: STATUS box children are stacked full-width blocks", () => {
    const titleIdx = laneViewSrc.indexOf('class="shepherd-title-row"');
    const badgeIdx = laneViewSrc.indexOf('class="shepherd-badge-row"');
    const progressIdx = laneViewSrc.indexOf('id="shepherdProgress"');
    const emptyIdx = laneViewSrc.indexOf('id="shepherdEmpty"');
    const reasonsIdx = laneViewSrc.indexOf('id="shepherdReasons"');
    assert.ok(titleIdx > 0 && badgeIdx > titleIdx);
    assert.ok(progressIdx > badgeIdx);
    assert.ok(emptyIdx > progressIdx);
    assert.ok(reasonsIdx > emptyIdx);
    assert.match(laneViewSrc, /\.shepherd-title-row,\s*\.shepherd-badge-row[\s\S]*?width:\s*100%/);
  });

  it("RAD-110: STATUS CSS wraps words, never overflow-wrap anywhere", () => {
    const shepherdBlock = laneViewSrc.slice(
      laneViewSrc.indexOf(".shepherd {"),
      laneViewSrc.indexOf(".pr {"),
    );
    assert.match(shepherdBlock, /#shepherdEmpty|\.shepherd-empty/);
    assert.match(shepherdBlock, /\.shepherd-reason \.message[^}]*overflow-wrap:\s*break-word/s);
    assert.match(shepherdBlock, /\.shepherd-progress \.step[^}]*overflow-wrap:\s*break-word/s);
    assert.equal(/overflow-wrap:\s*anywhere/.test(shepherdBlock), false);
    assert.match(shepherdBlock, /\.shepherd-reason \.ci-check[^}]*width:\s*auto/s);
  });
});
