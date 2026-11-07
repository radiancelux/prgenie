import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { dashboardFormatBrowserScript } from "./dashboard-format.js";
import { runnerUiHtml } from "./ui-html.js";

function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

describe("runnerUiHtml inline scripts", () => {
  it("emits JavaScript that parses in vm.Script", () => {
    const html = runnerUiHtml(8765, ["http://127.0.0.1:8765/"]);
    const scripts = inlineScriptBodies(html);
    assert.ok(scripts.length >= 1, "expected at least one inline script");
    for (const [i, body] of scripts.entries()) {
      assert.doesNotThrow(() => {
        new vm.Script(body, { filename: `runner-ui-inline-${i}.js` });
      }, `inline script ${i} should parse`);
    }
  });
});

function fixtureJobs() {
  const now = Date.now();
  return [
    {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 90_000).toISOString(),
      input: {
        repoPath: "/path/to/repo",
        branch: "feat/issue-319-chat-log-view",
        promptFile: "/tmp/p.md",
        maxRounds: 2,
        model: "composer-2.5",
        ticketUrl:
          "https://example.com/issue/ISSUE-319/local-runner-ui-render-stream-json-logs-as-readable-steps",
        linearIssue: "ISSUE-319",
        jobType: "code",
        profile: "code",
        title: "local-runner UI: render stream-json logs as readable steps",
      },
      stage: "building",
      reviewRound: 0,
      maxRounds: 2,
      model: "composer-2.5",
      driverId: "cursor-agent",
      worktreePath: null as string | null,
      repoSlug: "radiancelux/prgenie",
      prUrl: "https://github.com/radiancelux/prgenie/pull/111",
      prNumber: 111,
      prIsDraft: true,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: "ISSUE-319",
      ticketUrl:
        "https://example.com/issue/ISSUE-319/local-runner-ui-render-stream-json-logs-as-readable-steps",
      title: "local-runner UI: render stream-json logs as readable steps",
      tokenUsage: null,
      ciStatus: {
        status: "pending",
        summary: "running",
        checksUrl: null,
        mergedAt: null,
        source: "github",
        checkedAt: new Date().toISOString(),
      },
      lastVerdict: null,
      error: null,
      logPath: "/tmp/a.log",
      steerQueue: [],
      stopRequested: false,
      dryRun: false,
      archivedAt: null as string | null,
    },
    {
      id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      createdAt: new Date(now - 120_000).toISOString(),
      updatedAt: new Date(now - 45_000).toISOString(),
      input: {
        repoPath: "/path/to/docs-repo",
        branch: "docs/marketing-q4",
        promptFile: "",
        maxRounds: 2,
        model: "composer-2.5",
        ticketUrl: "https://example.com/issue/ISSUE-326/local-runner-non-technical-docs-mode",
        linearIssue: "ISSUE-326",
        jobType: "docs",
        profile: "docs",
        docsTemplate: "marketing",
        title: "Q4 marketing one-pager",
      },
      stage: "reviewing",
      reviewRound: 1,
      maxRounds: 2,
      model: "composer-2.5",
      driverId: "cursor-agent",
      worktreePath: null as string | null,
      repoSlug: "example-org/example-business",
      prUrl: null,
      prNumber: null,
      prIsDraft: null,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: "ISSUE-326",
      ticketUrl: "https://example.com/issue/ISSUE-326/local-runner-non-technical-docs-mode",
      title: "Q4 marketing one-pager",
      tokenUsage: null,
      ciStatus: {
        status: "success",
        summary: "ok",
        checksUrl: null,
        mergedAt: null,
        source: "docs",
        checkedAt: new Date().toISOString(),
      },
      lastVerdict: null,
      error: null,
      logPath: "/tmp/b.log",
      steerQueue: [],
      stopRequested: false,
      dryRun: false,
      archivedAt: null as string | null,
    },
  ];
}

describe("dashboardFormatBrowserScript runtime", () => {
  it("defines closed-over consts and labels docs stages", () => {
    const api = eval(dashboardFormatBrowserScript()) as {
      formatRelativeTime: (
        iso: string,
        now: number,
        locale?: string,
      ) => { label: string; title: string };
      dashboardStageLabel: (job: {
        stage: string;
        reviewRound: number;
        input: Record<string, unknown>;
      }) => string;
      jobAgentDisplayLabel: (job: Record<string, unknown>) => { label: string };
      jobRepoDisplayLabel: (job: Record<string, unknown>) => string;
    };
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    assert.equal(api.formatRelativeTime(tenMinAgo, Date.now(), "en-US").label, "10m ago");
    assert.equal(
      api.dashboardStageLabel({ stage: "building", reviewRound: 0, input: { jobType: "docs" } }),
      "Writing",
    );
    assert.equal(
      api.dashboardStageLabel({ stage: "reviewing", reviewRound: 1, input: { jobType: "docs" } }),
      "Review (r1)",
    );
    assert.equal(
      api.dashboardStageLabel({ stage: "building", reviewRound: 0, input: { jobType: "code" } }),
      "building",
    );
    const label = api.jobAgentDisplayLabel({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      title: "Hello",
      linearIssue: "ISSUE-319",
      ticketUrl: null,
      input: { branch: "feat/x" },
    });
    assert.equal(label.label, "ISSUE-319 · Hello");
  });
});

type FixtureJob = ReturnType<typeof fixtureJobs>[number];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  addEventListener() {}
  removeEventListener() {}
}

/** Per-job transcript streams, in creation order. */
function jobStreams(): FakeEventSource[] {
  return FakeEventSource.instances.filter((es) => es.url.startsWith("/api/jobs/"));
}

/** The dashboard-wide list stream (archive/restore/start from any client). */
function listStream(): FakeEventSource {
  const open = FakeEventSource.instances.filter(
    (es) => es.url.startsWith("/api/events") && es.readyState !== 2,
  );
  assert.equal(open.length, 1, "exactly one open list stream");
  return open[0];
}

const TERMINAL = new Set(["approved", "failed", "stopped", "changes_remaining", "stuck"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Boots the dashboard in jsdom with stubbed fetch, EventSource, and matchMedia. */
async function bootDashboard(opts: { jobs?: FixtureJob[]; desktop?: boolean } = {}) {
  const html = runnerUiHtml(9473, ["http://127.0.0.1:9473/"]);
  const state = { jobs: opts.jobs ?? fixtureJobs(), confirmAnswer: true };
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const confirms: string[] = [];
  const errors: string[] = [];
  let desktop = opts.desktop ?? true;
  const layoutListeners: Array<() => void> = [];
  FakeEventSource.instances = [];

  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:9473/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("prgenie_runner_token", "test-token");
      window.localStorage.setItem("prgenie_runner_show_all_jobs", "1");
    },
  });
  const { window } = dom;
  window.addEventListener("error", (ev) => {
    errors.push(String((ev as ErrorEvent).message || ev));
  });
  window.addEventListener("unhandledrejection", (ev) => {
    errors.push(String((ev as PromiseRejectionEvent).reason));
  });

  const jsonResponse = (body: unknown, status = 200) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => (typeof body === "string" ? JSON.parse(body || "{}") : body),
      text: async () => text,
    };
  };
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:9473/");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization || headers.authorization || "";
    if (!String(auth).includes("Bearer")) {
      return jsonResponse("unauthorized", 401);
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (method !== "GET") requests.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/jobs/meta") {
      const archived = state.jobs.filter((j) => j.archivedAt).length;
      return jsonResponse({ totalOnDisk: state.jobs.length - archived, mergedHidden: 0, archived });
    }
    const action = /^\/api\/jobs\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
    if (action && method === "POST") {
      const job = state.jobs.find((j) => j.id === action[1]);
      if (!job) return jsonResponse({ error: "job not found" }, 404);
      if (action[2] === "restore") {
        job.archivedAt = null;
        return jsonResponse({ ok: true, id: job.id, stage: job.stage });
      }
      if (!TERMINAL.has(job.stage)) {
        return jsonResponse({ error: "job is still running", stage: job.stage }, 409);
      }
      job.archivedAt = new Date().toISOString();
      const warning = job.worktreePath
        ? `Worktree kept at ${job.worktreePath} because it has uncommitted changes.`
        : undefined;
      return jsonResponse({ ok: true, id: job.id, worktree: warning ? "kept" : "none", warning });
    }
    if (url.pathname === "/api/jobs/clear-failed" && method === "POST") {
      const withStuck = (body as { includeStuckStopped?: boolean }).includeStuckStopped === true;
      const stages = withStuck ? ["failed", "stuck", "stopped"] : ["failed"];
      const archived: string[] = [];
      for (const j of state.jobs) {
        if (!j.archivedAt && stages.includes(j.stage)) {
          j.archivedAt = new Date().toISOString();
          archived.push(j.id);
        }
      }
      return jsonResponse({ ok: true, stages, archived, warnings: [], skipped: [] });
    }
    if (
      url.pathname.startsWith("/api/notify-settings") ||
      url.pathname.startsWith("/api/settings")
    ) {
      return jsonResponse({});
    }
    const single = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const job = state.jobs.find((j) => j.id === single[1]);
      return job
        ? jsonResponse({ ...job, logTail: `Transcript for ${job.id}` })
        : jsonResponse({}, 404);
    }
    if (url.pathname === "/api/jobs") {
      const withArchived = url.searchParams.get("includeArchived") === "1";
      return jsonResponse(state.jobs.filter((j) => withArchived || !j.archivedAt));
    }
    return jsonResponse({});
  }) as typeof fetch;
  window.confirm = (message?: string) => {
    confirms.push(String(message));
    return state.confirmAnswer;
  };
  (window as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
    media: query,
    get matches() {
      return desktop;
    },
    addEventListener: (_type: string, cb: () => void) => layoutListeners.push(cb),
    removeEventListener() {},
  });

  const scriptBodies = inlineScriptBodies(html);
  assert.ok(scriptBodies.length >= 1);
  for (const body of scriptBodies) {
    window.eval(body);
  }

  const doc = window.document;
  await waitFor(
    () => errors.length > 0 || doc.querySelectorAll("#jobs tr.job-row").length > 0,
    "job rows",
  );

  const win = window as unknown as { refresh: () => Promise<void> };
  return {
    window,
    doc,
    state,
    errors,
    requests,
    confirms,
    /** Remove/Restore button rendered for a job in the table row or mobile card. */
    rowAction: (id: string, action: "archive" | "restore") =>
      doc.querySelector<HTMLButtonElement>(
        `#jobs tr.job-row[data-id="${id}"] [data-action="${action}"]`,
      ),
    cardAction: (id: string, action: "archive" | "restore") =>
      doc.querySelector<HTMLButtonElement>(`#jobCards [data-id="${id}"] [data-action="${action}"]`),
    jobsStatus: () => doc.getElementById("jobsStatus")!.textContent ?? "",
    /** Table row or mobile card for a job. */
    row: (id: string) => doc.querySelector<HTMLElement>(`#jobs tr.job-row[data-id="${id}"]`)!,
    card: (id: string) => doc.querySelector<HTMLElement>(`#jobCards [data-id="${id}"]`)!,
    tableToggle: (id: string) =>
      doc.querySelector<HTMLButtonElement>(`#jobs tr.job-row[data-id="${id}"] .job-toggle`)!,
    cardToggle: (id: string) =>
      doc.querySelector<HTMLButtonElement>(`#jobCards [data-id="${id}"] .job-toggle`)!,
    panel: () => doc.querySelector<HTMLElement>(".job-detail")!,
    refresh: () => win.refresh(),
    setDesktop(value: boolean) {
      desktop = value;
      layoutListeners.forEach((cb) => cb());
    },
    close() {
      const highestId = Number(window.setTimeout(() => {}, 0));
      for (let id = 0; id <= highestId; id++) {
        window.clearTimeout(id);
        window.clearInterval(id);
      }
      window.close();
    },
  };
}

type Dashboard = Awaited<ReturnType<typeof bootDashboard>>;

async function withDashboard(
  opts: Parameters<typeof bootDashboard>[0],
  fn: (d: Dashboard) => Promise<void>,
): Promise<void> {
  const d = await bootDashboard(opts);
  try {
    await fn(d);
    assert.deepEqual(d.errors, [], `browser errors: ${d.errors.join(" | ")}`);
  } finally {
    d.close();
  }
}

const JOB_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const JOB_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function assertDetailUnderRow(d: Dashboard, id: string) {
  const detailRows = d.doc.querySelectorAll(".job-detail-row");
  assert.equal(detailRows.length, 1, "exactly one detail row");
  const next = d.row(id).nextElementSibling as HTMLTableRowElement | null;
  assert.ok(
    next && next.classList.contains("job-detail-row"),
    "detail row follows the selected row",
  );
  assert.equal(next.dataset.detailFor, id);
  assert.equal(next.cells.length, 1);
  assert.equal(next.cells[0].colSpan, 12);
  const panel = d.panel();
  assert.equal(panel.parentElement, next.cells[0], "panel lives in the companion row");
  assert.equal(panel.id, `job-detail-${id}`);
  assert.equal(d.doc.querySelectorAll(".job-detail").length, 1, "exactly one panel");
}

function assertExpanded(d: Dashboard, expandedId: string | null) {
  for (const toggle of d.doc.querySelectorAll<HTMLButtonElement>(".job-toggle")) {
    const id = (toggle.closest("[data-id]") as HTMLElement).dataset.id!;
    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.type, "button");
    assert.equal(toggle.getAttribute("aria-controls"), `job-detail-${id}`);
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      id === expandedId ? "true" : "false",
      `aria-expanded for ${id}`,
    );
  }
}

function assertCollapsed(d: Dashboard) {
  assert.equal(d.doc.querySelectorAll(".job-detail-row").length, 0);
  assert.equal(d.panel().parentElement?.id, "detailHome");
  assert.ok(d.doc.getElementById("detailHome")!.hidden);
  assertExpanded(d, null);
}

describe("runnerUiHtml inline job detail", () => {
  it("renders the detail panel in a companion row directly beneath the selected table row", async () => {
    await withDashboard({}, async (d) => {
      assertCollapsed(d);
      d.tableToggle(JOB_A).click();
      assertDetailUnderRow(d, JOB_A);
      assertExpanded(d, JOB_A);
      const panel = d.panel();
      for (const sel of ["#detailTitle", "#logSteps", "#steerPrompt", "#steerBtn", "#stopBtn"]) {
        assert.ok(panel.querySelector(sel), `panel contains ${sel}`);
      }
      assert.match(panel.querySelector("#detailTitle")!.textContent ?? "", /ISSUE-319/);
      assert.match(panel.querySelector("#detailStatus")!.textContent ?? "", /building/);
      await waitFor(
        () => (panel.querySelector("#logSteps")!.textContent ?? "").includes(JOB_A),
        "transcript for A",
      );
      assert.equal(jobStreams().length, 1);
      assert.match(jobStreams()[0].url, new RegExp(`/api/jobs/${JOB_A}/stream`));
    });
  });

  it("moves the single panel when switching rows and collapses on re-select", async () => {
    await withDashboard({}, async (d) => {
      d.tableToggle(JOB_A).click();
      const panel = d.panel();
      // Clicking anywhere in the row (not only the toggle) also expands.
      (d.row(JOB_B).querySelector('[data-label="Repo"]') as HTMLElement).dispatchEvent(
        new d.window.MouseEvent("click", { bubbles: true }),
      );
      assertDetailUnderRow(d, JOB_B);
      assertExpanded(d, JOB_B);
      assert.equal(d.panel(), panel, "same panel node is reused");
      assert.equal(jobStreams()[0].readyState, 2, "previous stream closed");
      await waitFor(
        () => (panel.querySelector("#logSteps")!.textContent ?? "").includes(JOB_B),
        "transcript for B",
      );
      assert.doesNotMatch(panel.querySelector("#logSteps")!.textContent ?? "", new RegExp(JOB_A));

      d.tableToggle(JOB_B).click();
      assertCollapsed(d);
      assert.equal(jobStreams()[1].readyState, 2, "stream closed on collapse");
    });
  });

  it("Escape inside the panel collapses it and returns focus to the row toggle", async () => {
    await withDashboard({}, async (d) => {
      d.tableToggle(JOB_A).click();
      const steer = d.doc.getElementById("steerPrompt") as HTMLTextAreaElement;
      steer.focus();
      steer.dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assertCollapsed(d);
      assert.equal(d.doc.activeElement, d.tableToggle(JOB_A));
    });
  });

  it("keeps the panel attached to its row across SSE re-renders, reorder, and new jobs", async () => {
    await withDashboard({}, async (d) => {
      d.tableToggle(JOB_A).click();
      const rowA = d.row(JOB_A);
      const panel = d.panel();
      await waitFor(
        () => (panel.querySelector("#logSteps")!.textContent ?? "").includes(JOB_A),
        "initial transcript",
      );
      const steer = d.doc.getElementById("steerPrompt") as HTMLTextAreaElement;
      steer.focus();
      steer.value = "draft guidance";
      steer.setSelectionRange(5, 5);

      const [a, b] = d.state.jobs;
      const c = { ...b, id: "cccccccc-dddd-eeee-ffff-000000000000", title: "Newest job" };
      d.state.jobs = [c, b, { ...a, stage: "reviewing", reviewRound: 1 }];
      jobStreams()[0].emit({ stage: "reviewing", logTail: "live tail line" });
      await waitFor(() => d.doc.querySelectorAll("#jobs tr.job-row").length === 3, "new job row");

      const order = [...d.doc.querySelectorAll<HTMLElement>("#jobs > tr")].map(
        (tr) => tr.dataset.id ?? `detail:${tr.dataset.detailFor}`,
      );
      assert.deepEqual(order, [c.id, JOB_B, JOB_A, `detail:${JOB_A}`]);
      assert.equal(d.row(JOB_A), rowA, "row node reused, not re-created");
      assertDetailUnderRow(d, JOB_A);
      assertExpanded(d, JOB_A);
      assert.equal(d.panel(), panel);
      assert.equal(steer.value, "draft guidance");
      assert.equal(d.doc.activeElement, steer, "focus survives the re-render");
      assert.equal(steer.selectionStart, 5);
      assert.match(panel.querySelector("#logSteps")!.textContent ?? "", /live tail line/);
      assert.match(d.row(JOB_A).textContent ?? "", /reviewing \(r1\)/);

      // A plain refresh with identical data must not move anything.
      await d.refresh();
      assertDetailUnderRow(d, JOB_A);
      assert.equal(d.doc.activeElement, steer);

      // Moving the selected row (and its detail row) to the top keeps focus and caret.
      d.state.jobs = [d.state.jobs[2], d.state.jobs[0], d.state.jobs[1]];
      await d.refresh();
      assert.equal(d.doc.querySelector("#jobs > tr"), rowA);
      assertDetailUnderRow(d, JOB_A);
      assert.equal(d.doc.activeElement, steer, "focus restored after the panel moved");
      assert.equal(steer.selectionStart, 5);
      assert.equal(steer.value, "draft guidance");
    });
  });

  it("collapses cleanly when the selected job disappears (e.g. merged and hidden)", async () => {
    await withDashboard({}, async (d) => {
      d.tableToggle(JOB_A).click();
      d.state.jobs = d.state.jobs.filter((j) => j.id !== JOB_A);
      await d.refresh();
      assert.equal(d.doc.querySelectorAll("#jobs tr.job-row").length, 1);
      assertCollapsed(d);
      assert.equal(jobStreams()[0].readyState, 2);
    });
  });

  it("expands mobile cards in place and follows layout changes", async () => {
    await withDashboard({ desktop: false }, async (d) => {
      d.cardToggle(JOB_B).click();
      const card = d.card(JOB_B);
      const panel = d.panel();
      assert.equal(panel.parentElement, card, "panel expands inside the tapped card");
      assert.ok(panel.previousElementSibling?.classList.contains("job-card-more"));
      assert.equal(panel.id, `job-detail-${JOB_B}`);
      for (const sel of ["#logSteps", "#steerPrompt", "#stopBtn"]) {
        assert.ok(panel.querySelector(sel), `card panel contains ${sel}`);
      }
      assert.equal(d.doc.querySelectorAll(".job-detail-row").length, 0);
      assertExpanded(d, JOB_B);

      d.cardToggle(JOB_A).click();
      assert.equal(d.panel().parentElement, d.card(JOB_A));
      assert.equal(d.doc.querySelectorAll(".job-detail").length, 1);

      const steer = d.doc.getElementById("steerPrompt") as HTMLTextAreaElement;
      steer.value = "keep me";
      d.setDesktop(true);
      assertDetailUnderRow(d, JOB_A);
      assert.equal(steer.value, "keep me");
      d.setDesktop(false);
      assert.equal(d.panel().parentElement, d.card(JOB_A));
      assert.equal(d.doc.querySelectorAll(".job-detail-row").length, 0);

      d.cardToggle(JOB_A).click();
      assertCollapsed(d);
    });
  });
});

describe("runnerUiHtml jsdom render", () => {
  it("renders agent rows with ID · title and repo without ReferenceError", async () => {
    await withDashboard({}, async (d) => {
      const rows = [...d.doc.querySelectorAll("#jobs tr.job-row")];
      assert.ok(rows.length >= 2, `expected rows, got ${rows.length}`);
      const bodyText = rows.map((r) => r.textContent ?? "").join("\n");
      assert.match(
        bodyText,
        /ISSUE-319\s*·\s*local-runner UI: render stream-json logs as readable steps/,
      );
      assert.match(bodyText, /ISSUE-326\s*·\s*Q4 marketing one-pager/);
      assert.match(bodyText, /radiancelux\/prgenie/);
      assert.match(bodyText, /example-org\/example-business/);
      // Docs plain-language stage + relative updated cell
      assert.match(bodyText, /Review \(r1\)/);
      assert.match(bodyText, /\d+m ago|just now|\d+s ago/);
      // Mobile cards render the same jobs with their own toggles.
      assert.equal(
        d.doc.querySelectorAll("#jobCards [role=listitem][data-id]").length,
        rows.length,
      );
    });
  });
});

function stagedJobs(stages: string[]): FixtureJob[] {
  const [base] = fixtureJobs();
  const now = Date.now();
  return stages.map((stage, i) => ({
    ...base,
    id: `job-${stage}`,
    stage,
    title: `${stage} agent`,
    createdAt: new Date(now - i * 1000).toISOString(),
  }));
}

const RUNNING_STAGES = ["building", "reviewing", "fixing"];
const TERMINAL_STAGES = ["failed", "stuck", "stopped", "approved", "changes_remaining"];

function rowIds(d: Dashboard): string[] {
  return [...d.doc.querySelectorAll<HTMLElement>("#jobs tr.job-row")].map((tr) => tr.dataset.id!);
}

function hasRow(d: Dashboard, id: string): boolean {
  return d.doc.querySelector(`#jobs tr.job-row[data-id="${id}"]`) !== null;
}

describe("runnerUiHtml job removal (archive)", () => {
  it("offers Remove only for terminal stages and never while a job is running", async () => {
    await withDashboard(
      { jobs: stagedJobs([...RUNNING_STAGES, ...TERMINAL_STAGES]) },
      async (d) => {
        for (const stage of RUNNING_STAGES) {
          assert.equal(d.rowAction(`job-${stage}`, "archive"), null, `no row Remove for ${stage}`);
          assert.equal(
            d.cardAction(`job-${stage}`, "archive"),
            null,
            `no card Remove for ${stage}`,
          );
        }
        for (const stage of TERMINAL_STAGES) {
          for (const btn of [
            d.rowAction(`job-${stage}`, "archive"),
            d.cardAction(`job-${stage}`, "archive"),
          ]) {
            assert.ok(btn, `Remove for ${stage}`);
            assert.equal(btn.tagName, "BUTTON");
            assert.equal(btn.type, "button");
            assert.match(
              btn.getAttribute("aria-label") ?? "",
              new RegExp(`Remove .*${stage} agent`),
            );
          }
        }

        const archiveBtn = d.doc.getElementById("archiveBtn") as HTMLButtonElement;
        d.tableToggle("job-building").click();
        assert.ok(archiveBtn.hidden, "panel Remove hidden while building");
        // The job finishes while its panel is open: Remove appears without reselecting.
        d.state.jobs[0].stage = "failed";
        jobStreams()[0].emit({ stage: "failed" });
        await waitFor(() => !archiveBtn.hidden, "panel Remove after failure");
        assert.equal(archiveBtn.textContent, "Remove");
        await waitFor(
          () => d.rowAction("job-building", "archive") !== null,
          "row Remove after failure",
        );
      },
    );
  });

  it("confirms before removing, then archives and closes the inline panel", async () => {
    const jobs = stagedJobs(["building", "failed"]);
    jobs[1].worktreePath = "/wt/failed";
    await withDashboard({ jobs }, async (d) => {
      d.tableToggle("job-failed").click();
      assertDetailUnderRow(d, "job-failed");
      const archiveBtn = d.doc.getElementById("archiveBtn") as HTMLButtonElement;
      assert.equal(archiveBtn.hidden, false);
      archiveBtn.focus();

      d.state.confirmAnswer = false;
      archiveBtn.click();
      assert.equal(d.confirms.length, 1);
      assert.match(d.confirms[0], /Remove "ISSUE-319 · failed agent"/);
      await sleep(30);
      assert.deepEqual(d.requests, [], "cancelled confirm sends nothing");
      assert.ok(hasRow(d, "job-failed"));

      d.state.confirmAnswer = true;
      archiveBtn.click();
      await waitFor(() => !hasRow(d, "job-failed"), "archived row removed");
      assert.deepEqual(d.requests, [
        { method: "POST", path: "/api/jobs/job-failed/archive", body: undefined },
      ]);
      assertCollapsed(d);
      assert.equal(jobStreams()[0].readyState, 2, "transcript stream closed");
      assert.equal(d.doc.activeElement, d.doc.getElementById("showAllJobs"), "focus falls back");
      assert.match(d.jobsStatus(), /Removed "ISSUE-319 · failed agent"/);
      assert.match(d.jobsStatus(), /Worktree kept at \/wt\/failed/);
    });
  });

  it("row and card Remove buttons are keyboard-focusable and keep focus on the page", async () => {
    await withDashboard({ jobs: stagedJobs(["failed", "stopped", "building"]) }, async (d) => {
      const rowBtn = d.rowAction("job-failed", "archive")!;
      rowBtn.focus();
      assert.equal(d.doc.activeElement, rowBtn);
      rowBtn.click();
      await waitFor(() => !hasRow(d, "job-failed"), "row removed");
      assertCollapsed(d);
      assert.equal(d.doc.activeElement, d.doc.getElementById("showAllJobs"));

      d.setDesktop(false);
      const cardBtn = d.cardAction("job-stopped", "archive")!;
      cardBtn.focus();
      cardBtn.click();
      await waitFor(
        () => d.doc.querySelector('#jobCards [data-id="job-stopped"]') === null,
        "card removed",
      );
      assert.equal(d.doc.activeElement, d.doc.getElementById("showAllJobs"));
      assert.deepEqual(
        d.requests.map((r) => r.path),
        ["/api/jobs/job-failed/archive", "/api/jobs/job-stopped/archive"],
      );
      assert.equal(d.confirms.length, 2, "each Remove confirms");
    });
  });

  it("Clear failed archives failed jobs, and stuck/stopped only when opted in", async () => {
    const stages = ["failed", "stuck", "stopped", "approved", "building", "changes_remaining"];
    await withDashboard({ jobs: stagedJobs(stages) }, async (d) => {
      const clearBtn = d.doc.getElementById("clearFailedBtn") as HTMLButtonElement;
      clearBtn.click();
      await waitFor(() => !hasRow(d, "job-failed"), "failed cleared");
      assert.match(d.confirms[0], /Remove 1 failed agent/);
      assert.deepEqual(d.requests[0], {
        method: "POST",
        path: "/api/jobs/clear-failed",
        body: { includeStuckStopped: false },
      });
      assert.deepEqual(rowIds(d), [
        "job-stuck",
        "job-stopped",
        "job-approved",
        "job-building",
        "job-changes_remaining",
      ]);

      (d.doc.getElementById("clearIncludeStuck") as HTMLInputElement).checked = true;
      clearBtn.click();
      await waitFor(() => !hasRow(d, "job-stuck"), "stuck cleared");
      assert.match(d.confirms[1], /Remove 2 failed, stuck, or stopped agent/);
      assert.deepEqual(d.requests[1].body, { includeStuckStopped: true });
      assert.deepEqual(rowIds(d), ["job-approved", "job-building", "job-changes_remaining"]);
      assert.match(d.jobsStatus(), /Removed 2 agent/);

      clearBtn.click();
      assert.match(d.jobsStatus(), /No failed, stuck, or stopped agents to clear/);
      assert.equal(d.requests.length, 2, "nothing to clear sends no request");
      assert.equal(d.confirms.length, 2);
    });
  });

  it("Show archived lists archived jobs with Restore, and Restore brings them back", async () => {
    const jobs = stagedJobs(["failed", "building"]);
    jobs[0].archivedAt = new Date().toISOString();
    await withDashboard({ jobs }, async (d) => {
      assert.deepEqual(rowIds(d), ["job-building"]);
      assert.match(d.doc.getElementById("jobsHiddenHint")!.textContent ?? "", /1 archived/);

      const toggle = d.doc.getElementById("showArchived") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new d.window.Event("change"));
      await waitFor(() => hasRow(d, "job-failed"), "archived row listed");
      assert.match(d.row("job-failed").textContent ?? "", /Archived/);
      assert.equal(d.rowAction("job-failed", "archive"), null, "archived rows have no Remove");
      assert.ok(d.cardAction("job-failed", "restore"));

      d.tableToggle("job-failed").click();
      const archiveBtn = d.doc.getElementById("archiveBtn") as HTMLButtonElement;
      assert.equal(archiveBtn.hidden, false);
      assert.equal(archiveBtn.textContent, "Restore");

      d.rowAction("job-failed", "restore")!.click();
      await waitFor(() => d.rowAction("job-failed", "archive") !== null, "restored row");
      assert.deepEqual(d.requests, [
        { method: "POST", path: "/api/jobs/job-failed/restore", body: undefined },
      ]);
      assert.equal(d.confirms.length, 0, "restore is not destructive, no confirm");
      assert.doesNotMatch(d.row("job-failed").textContent ?? "", /Archived/);
      assertDetailUnderRow(d, "job-failed");
      assert.equal(archiveBtn.textContent, "Remove");
    });
  });

  it("live list updates drop and re-add rows changed by another dashboard", async () => {
    await withDashboard({ jobs: stagedJobs(["failed", "building"]) }, async (d) => {
      assert.match(listStream().url, /^\/api\/events\?token=test-token$/);
      d.tableToggle("job-failed").click();
      // Steer is disabled for terminal jobs; any focusable control inside the panel will do.
      const rawToggle = d.doc.getElementById("showRaw") as HTMLInputElement;
      rawToggle.focus();
      assert.equal(d.doc.activeElement, rawToggle);

      d.state.jobs[0].archivedAt = new Date().toISOString();
      listStream().emit({ type: "jobs" });
      await waitFor(() => !hasRow(d, "job-failed"), "row dropped after remote archive");
      assertCollapsed(d);
      assert.equal(d.doc.activeElement, d.doc.getElementById("showAllJobs"));
      assert.deepEqual(d.requests, [], "this dashboard sent no archive request");

      d.state.jobs[0].archivedAt = null;
      listStream().emit({ type: "jobs" });
      await waitFor(() => hasRow(d, "job-failed"), "row re-added after remote restore");
      assert.deepEqual(rowIds(d), ["job-failed", "job-building"]);

      const before = listStream();
      (d.doc.getElementById("saveToken") as HTMLButtonElement).click();
      assert.equal(before.readyState, 2, "saving the token reconnects the list stream");
      assert.notEqual(listStream(), before);
    });
  });
});
