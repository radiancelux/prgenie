import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CI_CARD_SHELL_HTML,
  RENDER_CI_CARD_BODY,
  buildCiCardModel,
  ciStateTitle,
  formatCiProgressSummaryLine,
  formatExportGateBusyReason,
  isCiCheckDone,
  normalizeCiDisplayState,
  parseHeavySlotWaitMessage,
  resolveCiDisplayState,
  summarizeCiRun,
} from "./ciProgressView.js";

type FakeEl = {
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  textWrites: number;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
};

/** Just enough DOM for renderCiCard: class lookups into the injected shell. */
function fakeElement(): FakeEl {
  const children = new Map<string, FakeEl>();
  let html = "";
  let text = "";
  const el: FakeEl = {
    hidden: true,
    textWrites: 0,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      children.clear();
    },
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
      el.textWrites += 1;
    },
    querySelector(sel: string) {
      const cls = /^\.([\w-]+)/.exec(sel)?.[1];
      if (!cls || !html.includes(`class="${cls}`)) return null;
      if (sel.includes("[role='status']") && !html.includes('role="status"')) return null;
      if (!children.has(cls)) children.set(cls, fakeElement());
      return children.get(cls)!;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

type WebviewCi = {
  buildCiCardModel: (...args: unknown[]) => ReturnType<typeof buildCiCardModel>;
  normalizeCiDisplayState: (state?: string, cancelled?: boolean) => string;
  renderCiCard: (host: FakeEl, ...args: unknown[]) => void;
};

function loadWebviewCi(): WebviewCi {
  const factory = new Function(
    "escapeHtml",
    "formatElapsed",
    "vscode",
    `${RENDER_CI_CARD_BODY}; return { buildCiCardModel, normalizeCiDisplayState, renderCiCard };`,
  ) as (...deps: unknown[]) => WebviewCi;
  return factory(
    (s: unknown) => String(s ?? ""),
    (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`),
    { postMessage() {} },
  );
}

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

  it("shows every planned check, including ones that have not reported yet", () => {
    const model = buildCiCardModel({
      nowMs: T0 + 5_000,
      progress: {
        phase: "ci",
        startedAtMs: T0,
        checks: [
          { name: "format:check", state: "pass", elapsedMs: 900 },
          { name: "lint", state: "start" },
          { name: "test:core", state: "waiting" },
        ],
      },
      plan: { checks: ["format:check", "lint", "test:core", "build"] },
      stored: [{ name: "build", passed: true, elapsedMs: 4000 }],
    });
    assert.equal(model.rows.length, 4);
    assert.deepEqual(
      model.rows.map((r) => [r.name, r.state]),
      [
        ["format:check", "pass"],
        ["lint", "running"],
        ["test:core", "waiting"],
        ["build", "queued"],
      ],
    );
    assert.equal(model.countLine, "1 of 4 checks done");
    assert.match(model.summaryLine, /^1 of 4 checks done/);
  });

  it("keeps reported checks the plan did not list and uses stored results when idle", () => {
    const live = buildCiCardModel({
      progress: { phase: "ci", checks: [{ name: "extra", state: "pass" }] },
      plan: { checks: ["lint"] },
      stored: null,
    });
    assert.deepEqual(
      live.rows.map((r) => [r.name, r.state]),
      [
        ["lint", "queued"],
        ["extra", "pass"],
      ],
    );
    const idle = buildCiCardModel({
      progress: null,
      plan: { checks: ["lint", "build"] },
      stored: [{ name: "lint", passed: false }],
    });
    assert.deepEqual(
      idle.rows.map((r) => [r.name, r.state]),
      [
        ["lint", "fail"],
        ["build", "pending"],
      ],
    );
    assert.equal(idle.countLine, "1 of 2 checks done");
  });

  it("maps known runner states explicitly", () => {
    const cases: [string | undefined, string][] = [
      [undefined, "queued"],
      ["", "queued"],
      ["queued", "queued"],
      ["pending", "pending"],
      ["start", "running"],
      ["running", "running"],
      ["waiting", "waiting"],
      ["pass", "pass"],
      ["PASSED", "pass"],
      ["fail", "fail"],
      ["skip", "skipped"],
      ["skipped", "skipped"],
      ["cancelled", "cancelled"],
      ["canceled", "cancelled"],
      ["cached", "cached"],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(normalizeCiDisplayState(raw), expected, `state ${String(raw)}`);
      assert.equal(resolveCiDisplayState(raw).rawState, undefined);
    }
    assert.equal(normalizeCiDisplayState("start", true), "cancelled");
    assert.equal(normalizeCiDisplayState("pass", true), "pass");
    assert.equal(isCiCheckDone("skipped"), true);
    assert.equal(isCiCheckDone("pending"), false);
  });

  it("shows unrecognized states as Unknown with the raw value in the tooltip", () => {
    for (const raw of ["weird", "constructor", "toString"]) {
      const resolved = resolveCiDisplayState(raw);
      assert.deepEqual(resolved, { state: "unknown", rawState: raw });
      assert.equal(ciStateTitle(resolved), `Unknown runner state: ${raw}`);
    }
    const model = buildCiCardModel({
      progress: { phase: "ci", checks: [{ name: "lint", state: "weird" }] },
      plan: null,
      stored: null,
    });
    assert.equal(model.rows[0]?.state, "unknown");
    assert.equal(model.rows[0]?.rawState, "weird");
    assert.equal(isCiCheckDone("unknown"), false);
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

  it("webview model matches the planned-check merge and unknown fallback", () => {
    const ci = loadWebviewCi();
    const model = ci.buildCiCardModel(
      {
        phase: "ci",
        checks: [
          { name: "format:check", state: "pass" },
          { name: "lint", state: "start" },
          { name: "test", state: "weird" },
        ],
      },
      { checks: ["format:check", "lint", "test", "build"] },
      [{ name: "build", state: "pass" }],
      null,
      T0,
    );
    assert.equal(model.rows.length, 4);
    assert.equal(model.countLine, "1 of 4 checks done");
    assert.deepEqual(
      model.rows.map((r) => [r.name, r.state, r.rawState]),
      [
        ["format:check", "pass", undefined],
        ["lint", "running", undefined],
        ["test", "unknown", "weird"],
        ["build", "queued", undefined],
      ],
    );
    assert.equal(ci.normalizeCiDisplayState("pending"), "pending");
    assert.equal(ci.normalizeCiDisplayState("constructor"), "unknown");
  });

  it("wraps the progress count in a polite live region", () => {
    assert.match(
      CI_CARD_SHELL_HTML,
      /<span class="ci-card-count" role="status" aria-live="polite" aria-atomic="true">/,
    );
    assert.ok(RENDER_CI_CARD_BODY.includes(JSON.stringify(CI_CARD_SHELL_HTML)));

    const ci = loadWebviewCi();
    const host = fakeElement();
    const progress = (elapsedMs: number) => ({
      phase: "ci",
      startedAtMs: Date.now() - elapsedMs,
      checks: [{ name: "lint", state: "pass" }],
    });
    const plan = { checks: ["lint", "test"] };
    ci.renderCiCard(host, progress(2_000), plan, null, null);
    assert.equal(host.hidden, false);
    assert.match(host.innerHTML, /role="status" aria-live="polite"/);
    const count = host.querySelector(".ci-card-count")!;
    assert.equal(count.textContent, "1 of 2 checks done");
    assert.match(host.querySelector(".ci-card-elapsed")!.textContent, /s$/);

    ci.renderCiCard(host, progress(9_000), plan, null, null);
    assert.equal(host.querySelector(".ci-card-count"), count, "live region node persists");
    assert.equal(count.textWrites, 1, "elapsed ticks alone do not re-announce");
  });
});
