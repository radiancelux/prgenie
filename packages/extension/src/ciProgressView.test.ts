import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RENDER_CI_CARD_BODY,
  buildCiCardModel,
  formatCiProgressSummaryLine,
  formatExportGateBusyReason,
  isCiCheckDone,
  normalizeCiDisplayState,
  parseHeavySlotWaitMessage,
  summarizeCiRun,
} from "./ciProgressView.js";

describe("ciProgressView", () => {
  const T0 = 1_700_000_000_000;

  it("normalizes runner states for the sidebar", () => {
    assert.equal(normalizeCiDisplayState("start"), "running");
    assert.equal(normalizeCiDisplayState("queued"), "queued");
    assert.equal(normalizeCiDisplayState("waiting"), "waiting");
    assert.equal(normalizeCiDisplayState("pass"), "pass");
    assert.equal(isCiCheckDone("pass"), true);
    assert.equal(isCiCheckDone("running"), false);
  });

  it("parses heavy-test slot wait copy", () => {
    const msg =
      "waiting for heavy-test slot (2/2 busy: lp-demo-a test:core 45s, lp-demo-b test 12s) — waited 18s";
    assert.match(parseHeavySlotWaitMessage(msg) ?? "", /lp-demo-a/);
  });

  it("builds mixed-state rows with done counts and overall elapsed", () => {
    const model = buildCiCardModel({
      nowMs: T0 + 45_000,
      progress: {
        phase: "ci",
        state: "start",
        startedAtMs: T0,
        selectionReason: "synthetic fixture",
        checks: [
          { name: "format:check", state: "pass", elapsedMs: 1200 },
          {
            name: "lint",
            state: "fail",
            elapsedMs: 3400,
            logPath: ".git/agent-console/ci-logs/lint.log",
          },
          {
            name: "test:core",
            state: "waiting",
            message: "waiting for heavy-test slot (1/2 busy: lp-queue test:core 30s) — waited 5s",
          },
          { name: "build", state: "queued" },
        ],
      },
      plan: { checks: ["format:check", "lint", "test:core", "build"], reason: "plan" },
      stored: null,
    });
    assert.equal(model.show, true);
    assert.equal(model.rows.length, 4);
    assert.match(model.summaryLine, /2 of 4 checks done/);
    assert.match(model.summaryLine, /45\.0s/);
    assert.match(model.slotQueueLine ?? "", /lp-queue/);
    const failed = model.rows.find((r) => r.name === "lint");
    assert.equal(failed?.state, "fail");
    assert.ok(failed?.logPath);
  });

  it("webview CI script defines gate busy reason via positional buildCiCardModel", () => {
    assert.match(RENDER_CI_CARD_BODY, /function formatExportGateBusyReason/);
    assert.doesNotMatch(RENDER_CI_CARD_BODY, /buildCiCardModel\(\{/);
    assert.match(
      RENDER_CI_CARD_BODY,
      /buildCiCardModel\(input\.progress,\s*input\.plan,\s*input\.stored/,
    );
  });

  it("formats export gate disabled reason from live progress", () => {
    const reason = formatExportGateBusyReason({
      step: "Re-running gate CI → test",
      progress: {
        phase: "ci",
        startedAtMs: T0,
        checks: [
          { name: "test", state: "pass", elapsedMs: 2000 },
          { name: "lint", state: "start" },
        ],
      },
      plan: { checks: ["test", "lint"] },
      stored: null,
      nowMs: T0 + 10_000,
    });
    assert.match(reason, /Open on GitHub unavailable/);
    assert.match(reason, /1 of 2 checks done/);
  });

  it("summarizeCiRun prefers wall clock when startedAtMs is set", () => {
    const rows = [
      { name: "a", displayName: "a", state: "pass", elapsedMs: 500 },
      { name: "b", displayName: "b", state: "running" },
    ];
    const timing = summarizeCiRun(rows, { nowMs: T0 + 8000, startedAtMs: T0 });
    assert.equal(timing.overallElapsedMs, 8000);
    assert.equal(formatCiProgressSummaryLine(1, 2, 8000), "1 of 2 checks done · 8.0s");
  });
});
