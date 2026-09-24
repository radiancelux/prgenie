import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHEAP_SHEPHERD_DEBOUNCE_MS,
  createCheapShepherdScheduler,
  createCoalescingFlight,
  createExportGateScheduler,
  SIDEBAR_SHEPHERD_OPTIONS,
} from "./sidebarPoller.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("SIDEBAR_SHEPHERD_OPTIONS skips CI (Slice 0 cheap path)", () => {
  assert.equal(SIDEBAR_SHEPHERD_OPTIONS.skipCiCheck, true);
  assert.equal(CHEAP_SHEPHERD_DEBOUNCE_MS, 30_000);
});

test("coalescing flight: overlapping calls share one in-flight run", async () => {
  let running = 0;
  let maxRunning = 0;
  let runs = 0;
  const enqueue = createCoalescingFlight(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    runs += 1;
    await delay(30);
    running -= 1;
  });

  await Promise.all([enqueue(), enqueue(), enqueue()]);

  assert.equal(maxRunning, 1, "must never overlap snapshot work");
  assert.ok(runs >= 1 && runs <= 2, `expected 1–2 runs after coalesce, got ${runs}`);
});

test("coalescing flight: call during run schedules exactly one follow-up", async () => {
  const started: boolean[] = [];
  let release!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seenFirst = false;
  const enqueue = createCoalescingFlight(async () => {
    started.push(true);
    if (!seenFirst) {
      seenFirst = true;
      await firstGate;
    }
  });

  const first = enqueue();
  const mid = [enqueue(), enqueue(), enqueue(true)];
  release();
  await first;
  await Promise.all(mid);

  assert.equal(started.length, 2, "in-flight + one trailing coalesce");
});

test("coalescing flight: queued force ORs onto the follow-up run", async () => {
  const forces: boolean[] = [];
  let release!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seenFirst = false;
  const enqueue = createCoalescingFlight(async (force) => {
    forces.push(force);
    if (!seenFirst) {
      seenFirst = true;
      await firstGate;
    }
  });

  const first = enqueue(false);
  const queued = enqueue(true);
  release();
  await first;
  await queued;

  assert.deepEqual(forces, [false, true]);
});

test("coalescing flight: sequential calls after idle each run", async () => {
  let runs = 0;
  const enqueue = createCoalescingFlight(async () => {
    runs += 1;
  });
  await enqueue();
  await enqueue();
  await enqueue();
  assert.equal(runs, 3);
});

test("cheap shepherd scheduler is single-flight and ignores in-flight overlap", async () => {
  let inflight = 0;
  let maxInflight = 0;
  let fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results: string[] = [];
  const scheduler = createCheapShepherdScheduler({
    debounceMs: 30_000,
    fetch: async (_root, id) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      fetches += 1;
      await gate;
      inflight -= 1;
      return id;
    },
    onResult: (_id, result) => {
      results.push(result);
    },
  });

  scheduler.schedule("/repo", "lp-a");
  scheduler.schedule("/repo", "lp-a");
  scheduler.schedule("/repo", "lp-a");
  release();
  await delay(20);

  assert.equal(maxInflight, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(results, ["lp-a"]);
});

test("cheap shepherd scheduler debounce skips same-id refetch", async () => {
  let fetches = 0;
  let t = 1_000;
  const scheduler = createCheapShepherdScheduler({
    now: () => t,
    debounceMs: 30_000,
    fetch: async (_root, id) => {
      fetches += 1;
      return id;
    },
    onResult: () => {},
  });

  scheduler.schedule("/repo", "lp-a");
  await delay(10);
  t = 20_000;
  scheduler.schedule("/repo", "lp-a");
  await delay(10);
  assert.equal(fetches, 1);

  t = 32_000;
  scheduler.schedule("/repo", "lp-a");
  await delay(10);
  assert.equal(fetches, 2);
});

test("cheap shepherd scheduler fetches immediately when selected id changes", async () => {
  let fetches = 0;
  const results: string[] = [];
  let t = 1_000;
  const scheduler = createCheapShepherdScheduler({
    now: () => t,
    debounceMs: 30_000,
    fetch: async (_root, id) => {
      fetches += 1;
      return id;
    },
    onResult: (_id, result) => {
      results.push(result);
    },
  });

  scheduler.schedule("/repo", "lp-a");
  await delay(10);
  t = 2_000;
  scheduler.schedule("/repo", "lp-b");
  await delay(10);

  assert.equal(fetches, 2);
  assert.deepEqual(results, ["lp-a", "lp-b"]);
});

test("cheap shepherd scheduler drops stale result when selection changes mid-flight", async () => {
  const gates = new Map<string, () => void>();
  const waitFor = (id: string) =>
    new Promise<void>((resolve) => {
      gates.set(id, resolve);
    });
  const results: string[] = [];
  const scheduler = createCheapShepherdScheduler({
    debounceMs: 0,
    fetch: async (_root, id) => {
      await waitFor(id);
      return id;
    },
    onResult: (_id, result) => {
      results.push(result);
    },
  });

  scheduler.schedule("/repo", "lp-a");
  await delay(5);
  scheduler.schedule("/repo", "lp-b");
  gates.get("lp-a")?.();
  await delay(10);
  assert.deepEqual(results, [], "stale lp-a must not paint");
  gates.get("lp-b")?.();
  await delay(10);
  assert.deepEqual(results, ["lp-b"]);
});

test("laneView snapshot path does not await full shepherdStatus", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
    "utf8",
  );
  assert.equal(
    /await\s+shepherdStatus\s*\(/.test(src),
    false,
    "poller must not await shepherdStatus (and therefore runCiChecks)",
  );
  assert.ok(src.includes("SIDEBAR_SHEPHERD_OPTIONS"));
  assert.ok(src.includes("createCoalescingFlight"));
  assert.ok(src.includes("scheduleGithubArchive"));
});

test("CLI shepherd persists the same full export gate (no skipCiCheck)", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../cli/src/cli.ts"),
    "utf8",
  );
  assert.match(src, /if \(sub === "shepherd"\)/);
  assert.match(src, /evaluateAndStoreExportGate\(repo, id,/);
  assert.match(src, /formatProgressLine/);
  assert.match(src, /Ctrl\+C to cancel/);
  assert.match(src, /--verbose/);
  assert.match(src, /printVerboseFailureLog/);
  assert.equal(/shepherdStatus\(repo, id,\s*\{/.test(src), false);
});

test("laneView CI modal queries fresh nodes after loop switch (AC3)", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
    "utf8",
  );
  assert.equal(
    /ciModalBound/.test(src),
    false,
    "must not skip rebind after root.innerHTML rebuild",
  );
  assert.match(src, /Query fresh #ciModal nodes/);
  assert.match(src, /getElementById\("ciModal"\)/);
  assert.match(src, /bindCiModal\(\);/);
  assert.match(src, /abortCiForSteward\(cancelCwd, cancelId\)/);
  assert.match(src, /stop_implementor_and_abort_ci/);
  assert.match(src, /Panel Cancel is the skip half/);
  assert.match(src, /function formatElapsed/);
});

test("laneView Push to origin / export CTA use humanExport, not bare reviewed status", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
    "utf8",
  );
  assert.equal(
    /const yourTurn = pr\.status === "reviewed"/.test(src),
    false,
    "list must not treat reviewed as Push to origin before the export gate is green",
  );
  assert.ok(src.includes("humanExport"));
  assert.ok(src.includes("showExportPrimary"));
  assert.ok(src.includes("createExportGateScheduler"));
  assert.ok(src.includes("evaluateAndStoreExportGate"));
  assert.ok(src.includes("cancelProgress"));
  assert.ok(src.includes("formatProgressStep"));
  assert.ok(src.includes("exportBusy"));
  assert.ok(src.includes("promptExportReadyEnter"));
  assert.ok(src.includes("humanExportEnterMessage"));
  assert.ok(src.includes("HUMAN_EXPORT_PRIMARY_ACTION"));
  assert.ok(src.includes("push-to-origin"));
  assert.ok(src.includes("editorWarning-foreground"));
  assert.equal(
    src.includes("your-turn") || src.includes("reviewed-turn") || /your turn/i.test(src),
    false,
    "user-facing Your Turn copy must be gone",
  );
  assert.equal(
    /await\s+evaluateAndStoreExportGate\s*\(/.test(src),
    false,
    "snapshot path must not await full export-gate CI",
  );
});

test("laneView export surfaces partialFailure as warning (RAD-95)", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
    "utf8",
  );
  assert.ok(src.includes("formatExportPartialFailure"));
  assert.ok(src.includes("result.partialFailure"));
  assert.ok(src.includes("showWarningMessage"));
  // Success toast must not be the only path after exportLocalPr resolves.
  assert.match(
    src,
    /if\s*\(\s*result\.partialFailure\s*\)[\s\S]*showWarningMessage[\s\S]*formatExportPartialFailure/,
  );
});

test("laneView STATUS quiet until reviewed; idle clear; no vertical reason layout", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
    "utf8",
  );
  assert.match(
    src,
    /selected\.status === "reviewed"\s*\?\s*displayShepherdStatus/,
    "cheap shepherd BLOCKED must not paint for draft/ready loops",
  );
  assert.ok(src.includes("STATUS_PANEL_TITLE"));
  assert.ok(src.includes("statusPanelGuidanceForLoop"));
  assert.ok(src.includes("statusPanelIdleBody"));
  assert.ok(src.includes("STATUS_PHASE"));
  assert.ok(src.includes("shepherdEmpty"));
  assert.ok(src.includes("shepherd-header-row"));
  assert.ok(src.includes("flex-direction: column"));
  assert.ok(src.includes("exportingId"));
  assert.ok(src.includes("Reusing green gate"));
  assert.ok(src.includes("Re-running gate CI"));
  assert.ok(src.includes("exportBusyHint"));
  assert.match(src, /\.shepherd-reason \.ci-check\s*\{[^}]*width:\s*auto/s);
  assert.equal(
    /\.shepherd-reason \.message[^}]*overflow-wrap:\s*anywhere/.test(src),
    false,
    "overflow-wrap:anywhere + squeezed width stacked one char per line",
  );
  assert.equal(
    /<span class="label">export<\/span>/.test(src),
    false,
    "section title must be STATUS, not export",
  );
});

test("export gate scheduler runs once per id+HEAD and ignores in-flight overlap", async () => {
  let inflight = 0;
  let maxInflight = 0;
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done: string[] = [];
  const scheduler = createExportGateScheduler({
    evaluate: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      runs += 1;
      await gate;
      inflight -= 1;
    },
    onDone: (id) => {
      done.push(id);
    },
  });
  const pr = {
    id: "lp-a",
    status: "reviewed",
    headSha: "aaa",
    exportGate: { status: "pending" as const, reasons: [], headSha: "aaa", evaluatedAt: null },
  };
  scheduler.schedule("/repo", pr);
  scheduler.schedule("/repo", pr);
  scheduler.schedule("/repo", pr);
  release();
  await delay(20);
  assert.equal(maxInflight, 1);
  assert.equal(runs, 1);
  assert.deepEqual(done, ["lp-a"]);
});

test("export gate scheduler skips loops that are not waiting on the gate", async () => {
  let runs = 0;
  const scheduler = createExportGateScheduler({
    evaluate: async () => {
      runs += 1;
    },
  });
  scheduler.schedule("/repo", {
    id: "lp-ready",
    status: "ready",
    headSha: "aaa",
  });
  scheduler.schedule("/repo", {
    id: "lp-green",
    status: "reviewed",
    headSha: "bbb",
    exportGate: { status: "ready", reasons: [], headSha: "bbb", evaluatedAt: "now" },
  });
  await delay(10);
  assert.equal(runs, 0);
});

test("export gate scheduler cancel skips auto-retry until retry()", async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = createExportGateScheduler({
    evaluate: async (_root, _id, ctx) => {
      runs += 1;
      await Promise.race([
        gate,
        new Promise<never>((_, reject) => {
          ctx.signal.addEventListener("abort", () => {
            const err = new Error("Cancelled");
            err.name = "AbortError";
            reject(err);
          });
        }),
      ]);
    },
  });
  const pr = {
    id: "lp-a",
    status: "reviewed",
    headSha: "aaa",
    exportGate: { status: "pending" as const, reasons: [], headSha: "aaa", evaluatedAt: null },
  };
  scheduler.schedule("/repo", pr);
  assert.equal(scheduler.inFlight(), true);
  scheduler.cancel();
  await delay(20);
  assert.equal(runs, 1);
  scheduler.schedule("/repo", pr);
  await delay(10);
  assert.equal(runs, 1, "cancelled id+HEAD must not auto-restart");
  release();
  scheduler.retry("/repo", pr);
  await delay(20);
  assert.equal(runs, 2);
});
