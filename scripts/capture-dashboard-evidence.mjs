/**
 * Generates responsive dashboard screenshots (synthetic fixture) with the first job expanded.
 * Requires: pnpm build && npx playwright install chromium
 */
import { execFileSync } from "node:child_process";
import { setTimeout as startTimer } from "node:timers";
import { setTimeout } from "node:timers/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const OVERALL_TIMEOUT_MS = 120_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
startTimer(() => {
  console.error(`capture-dashboard-evidence: timed out after ${OVERALL_TIMEOUT_MS} ms`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/runner-dashboard-evidence");
mkdirSync(outDir, { recursive: true });

const builtCss = readFileSync(path.join(root, "local-runner/dist/dashboard.min.css"), "utf8");
const { runnerUiHtml } = await import(
  pathToFileURL(path.join(root, "local-runner/src/ui-html.ts")).href
);

function syntheticJob(overrides) {
  return {
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date(Date.now() - 90000).toISOString(),
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "composer-2.5",
    driverId: "cursor-agent",
    worktreePath: null,
    prIsDraft: true,
    approveHeadSha: null,
    readyPromotedAt: null,
    tokenUsage: { input: 1200, output: 400, cacheRead: 0, cacheWrite: 0, total: 1600 },
    ciStatus: {
      status: "pending",
      summary: "checks running",
      source: "github",
      checkedAt: new Date().toISOString(),
    },
    lastVerdict: null,
    error: null,
    logPath: "/tmp/synthetic.log",
    steerQueue: [],
    stopRequested: false,
    dryRun: false,
    archivedAt: null,
    ...overrides,
  };
}

const jobs = [
  syntheticJob({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    input: {
      repoPath: "/path/to/synthetic-repo",
      branch: "feat/synthetic-dashboard",
      promptFile: "/tmp/p.md",
      jobType: "code",
      title: "Synthetic agent row for dashboard evidence",
      linearIssue: "ISSUE-900",
      ticketUrl: "https://example.com/issue/ISSUE-900/synthetic-dashboard",
    },
    repoSlug: "example-org/synthetic-app",
    prUrl: "https://github.com/example-org/synthetic-app/pull/42",
    prNumber: 42,
    linearIssue: "ISSUE-900",
    ticketUrl: "https://example.com/issue/ISSUE-900/synthetic-dashboard",
    title: "Synthetic agent row for dashboard evidence",
  }),
  syntheticJob({
    id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    updatedAt: new Date(Date.now() - 600000).toISOString(),
    stage: "reviewing",
    reviewRound: 1,
    input: {
      repoPath: "/path/to/synthetic-docs",
      branch: "docs/synthetic-onepager",
      promptFile: "",
      jobType: "docs",
      docsTemplate: "marketing",
      title: "Synthetic docs agent below the expanded row",
      linearIssue: "ISSUE-901",
      ticketUrl: "https://example.com/issue/ISSUE-901/synthetic-docs",
    },
    repoSlug: "example-org/synthetic-docs",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    linearIssue: "ISSUE-901",
    ticketUrl: "https://example.com/issue/ISSUE-901/synthetic-docs",
    title: "Synthetic docs agent below the expanded row",
    ciStatus: {
      status: "success",
      summary: "ok",
      source: "docs",
      checkedAt: new Date().toISOString(),
    },
  }),
  syntheticJob({
    id: "cccccccc-dddd-eeee-ffff-000000000000",
    updatedAt: new Date(Date.now() - 1_200_000).toISOString(),
    stage: "failed",
    input: {
      repoPath: "/path/to/synthetic-repo",
      branch: "feat/synthetic-failed",
      promptFile: "/tmp/p.md",
      jobType: "code",
      title: "Synthetic failed agent with Remove",
      linearIssue: "ISSUE-902",
    },
    repoSlug: "example-org/synthetic-app",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    linearIssue: "ISSUE-902",
    ticketUrl: null,
    title: "Synthetic failed agent with Remove",
    ciStatus: null,
    error: "synthetic failure",
  }),
];

const logTail = [
  "Reading local-runner/src/ui-html.ts",
  "Planning: render the selected agent's detail inline beneath its row.",
  "Running pnpm test …",
].join("\n");

let html = runnerUiHtml(9473, ["http://127.0.0.1:9473/"]);
html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>${builtCss}</style>`);

/** Renders the dashboard in jsdom, expands the first job, and returns static HTML. */
async function renderSnapshot(desktop) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:9473/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("prgenie_runner_token", "synthetic-evidence-token");
      window.localStorage.setItem("prgenie_runner_show_finished", "1");
      const jsonResponse = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      window.fetch = async (input) => {
        const url = new URL(String(input), "http://127.0.0.1:9473/");
        if (url.pathname === "/api/jobs/meta")
          return jsonResponse({ totalOnDisk: jobs.length, mergedHidden: 0, archived: 2 });
        const single = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
        if (single) return jsonResponse({ ...jobs.find((j) => j.id === single[1]), logTail });
        if (url.pathname === "/api/jobs") return jsonResponse(jobs);
        return jsonResponse({});
      };
      window.EventSource = class {
        close() {}
      };
      window.matchMedia = (media) => ({
        media,
        matches: desktop,
        addEventListener() {},
        removeEventListener() {},
      });
    },
  });
  const doc = dom.window.document;
  const script = [...doc.querySelectorAll("script")].map((s) => s.textContent).join("\n");
  dom.window.eval(script);
  await setTimeout(200);
  const container = desktop ? "#jobs" : "#jobCards";
  doc.querySelector(`${container} [data-id="${jobs[0].id}"] .job-toggle`)?.click();
  await setTimeout(200);
  for (const s of doc.querySelectorAll("script")) s.remove();
  const out = dom.serialize();
  dom.window.close();
  return out;
}

const desktopSnapshot = await renderSnapshot(true);
const mobileSnapshot = await renderSnapshot(false);
const snapPath = path.join(outDir, "fixture-snapshot.html");
writeFileSync(snapPath, desktopSnapshot);
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "prgenie-dashboard-"));
const mobileSnapPath = path.join(tmpDir, "fixture-snapshot-mobile.html");
writeFileSync(mobileSnapPath, mobileSnapshot);

const shots = [
  { width: 360, file: mobileSnapPath },
  { width: 390, file: mobileSnapPath },
  { width: 768, file: mobileSnapPath },
  { width: 1024, file: snapPath },
  { width: 1280, file: snapPath },
];
try {
  for (const { width, file } of shots) {
    const out = path.join(outDir, `dashboard-${width}px.png`);
    execFileSync(
      "npx",
      [
        "playwright",
        "screenshot",
        "--full-page",
        "--viewport-size",
        `${width},900`,
        `file://${file}`,
        out,
      ],
      { cwd: root, stdio: "inherit", timeout: SCREENSHOT_TIMEOUT_MS },
    );
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log("Wrote screenshots to", outDir);
process.exit(0);
