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
        repoPath: "/home/brett/dev/prgenie",
        branch: "feat/rad-319-chat-log-view",
        promptFile: "/tmp/p.md",
        maxRounds: 2,
        model: "composer-2.5",
        ticketUrl:
          "https://linear.app/radiancelux/issue/RAD-319/local-runner-ui-render-stream-json-logs-as-readable-steps",
        linearIssue: "RAD-319",
        jobType: "code",
        profile: "code",
        title: "local-runner UI: render stream-json logs as readable steps",
      },
      stage: "building",
      reviewRound: 0,
      maxRounds: 2,
      model: "composer-2.5",
      driverId: "cursor-agent",
      worktreePath: null,
      repoSlug: "radiancelux/prgenie",
      prUrl: "https://github.com/radiancelux/prgenie/pull/111",
      prNumber: 111,
      prIsDraft: true,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: "RAD-319",
      ticketUrl:
        "https://linear.app/radiancelux/issue/RAD-319/local-runner-ui-render-stream-json-logs-as-readable-steps",
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
      archivedAt: null,
    },
    {
      id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      createdAt: new Date(now - 120_000).toISOString(),
      updatedAt: new Date(now - 45_000).toISOString(),
      input: {
        repoPath: "/home/brett/dev/img-business",
        branch: "docs/marketing-q4",
        promptFile: "",
        maxRounds: 2,
        model: "composer-2.5",
        ticketUrl:
          "https://linear.app/radiancelux/issue/RAD-326/local-runner-non-technical-docs-mode",
        linearIssue: "RAD-326",
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
      worktreePath: null,
      repoSlug: "cc-consulting-nv/img-business",
      prUrl: null,
      prNumber: null,
      prIsDraft: null,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: "RAD-326",
      ticketUrl:
        "https://linear.app/radiancelux/issue/RAD-326/local-runner-non-technical-docs-mode",
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
      archivedAt: null,
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
      linearIssue: "RAD-319",
      ticketUrl: null,
      input: { branch: "feat/x" },
    });
    assert.equal(label.label, "RAD-319 · Hello");
  });
});

describe("runnerUiHtml jsdom render", () => {
  it("renders agent rows with ID · title and repo without ReferenceError", async () => {
    const html = runnerUiHtml(9473, ["http://127.0.0.1:9473/"]);
    const jobs = fixtureJobs();
    const errors: string[] = [];

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
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization || headers.authorization || "";
      if (!String(auth).includes("Bearer")) {
        return jsonResponse("unauthorized", 401);
      }
      if (url.includes("/api/jobs/meta")) {
        return jsonResponse({ totalOnDisk: jobs.length, mergedHidden: 0 });
      }
      if (url.includes("/api/notify-settings") || url.includes("/api/settings")) {
        return jsonResponse({});
      }
      if (url.includes("/api/jobs")) {
        return jsonResponse(jobs);
      }
      return jsonResponse({});
    }) as typeof fetch;

    class FakeEventSource {
      url: string;
      readyState = 1;
      constructor(url: string) {
        this.url = url;
      }
      close() {
        this.readyState = 2;
      }
      addEventListener() {}
      removeEventListener() {}
    }
    // @ts-expect-error test stub
    window.EventSource = FakeEventSource;

    const scriptBodies = inlineScriptBodies(html);
    assert.ok(scriptBodies.length >= 1);
    for (const body of scriptBodies) {
      window.eval(body);
    }

    const tokenEl = window.document.getElementById("token") as HTMLInputElement | null;
    if (tokenEl) tokenEl.value = "test-token";
    window.document.getElementById("saveToken")?.dispatchEvent(new window.Event("click"));

    // Allow async refreshJobs to settle
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 20 && errors.length === 0; i++) {
      const n = window.document.querySelectorAll("#jobs tr.job-row").length;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Clear recurring timers so the test process can exit.
    const highestId = Number(window.setTimeout(() => {}, 0));
    for (let id = 0; id <= highestId; id++) {
      window.clearTimeout(id);
      window.clearInterval(id);
    }

    assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
    const rows = [...window.document.querySelectorAll("#jobs tr.job-row")];
    assert.ok(rows.length >= 2, `expected rows, got ${rows.length}`);
    const bodyText = rows.map((r) => r.textContent ?? "").join("\n");
    assert.match(
      bodyText,
      /RAD-319\s*·\s*local-runner UI: render stream-json logs as readable steps/,
    );
    assert.match(bodyText, /RAD-326\s*·\s*Q4 marketing one-pager/);
    assert.match(bodyText, /radiancelux\/prgenie/);
    assert.match(bodyText, /cc-consulting-nv\/img-business/);
    // Docs plain-language stage + relative updated cell
    assert.match(bodyText, /Review \(r1\)/);
    assert.match(bodyText, /\d+m ago|just now|\d+s ago/);

    dom.window.close();
  });
});
