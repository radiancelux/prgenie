/**
 * Generates responsive dashboard screenshots (synthetic fixture).
 * Requires: pnpm build && npx playwright install chromium
 */
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/runner-dashboard-evidence");
mkdirSync(outDir, { recursive: true });

const builtCss = readFileSync(path.join(root, "local-runner/dist/dashboard.min.css"), "utf8");
const { runnerUiHtml } = await import(
  pathToFileURL(path.join(root, "local-runner/src/ui-html.ts")).href
);

const jobs = [
  {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date(Date.now() - 90000).toISOString(),
    input: {
      repoPath: "/path/to/synthetic-repo",
      branch: "feat/synthetic-dashboard",
      promptFile: "/tmp/p.md",
      jobType: "code",
      title: "Synthetic agent row for dashboard evidence",
      linearIssue: "ISSUE-900",
      ticketUrl: "https://example.com/issue/ISSUE-900/synthetic-dashboard",
    },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "composer-2.5",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "example-org/synthetic-app",
    prUrl: "https://github.com/example-org/synthetic-app/pull/42",
    prNumber: 42,
    prIsDraft: true,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: "ISSUE-900",
    ticketUrl: "https://example.com/issue/ISSUE-900/synthetic-dashboard",
    title: "Synthetic agent row for dashboard evidence",
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
  },
];

let html = runnerUiHtml(9473, ["http://127.0.0.1:9473/"]);
html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>${builtCss}</style>`);

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
      const url = String(input);
      if (url.includes("/api/jobs/meta")) return jsonResponse({ totalOnDisk: 1, mergedHidden: 0 });
      if (url.includes("/api/jobs")) return jsonResponse(jobs);
      if (url.includes("/api/notify-settings") || url.includes("/api/settings"))
        return jsonResponse({});
      return jsonResponse({});
    };
    window.EventSource = class {
      close() {}
    };
  },
});

const script = [...dom.window.document.querySelectorAll("script")]
  .map((s) => s.textContent)
  .join("\n");
dom.window.eval(script);
await setTimeout(200);

const snapPath = path.join(outDir, "fixture-snapshot.html");
writeFileSync(snapPath, dom.serialize());

const widths = [360, 390, 768];
for (const w of widths) {
  const out = path.join(outDir, `dashboard-${w}px.png`);
  execFileSync(
    "npx",
    ["playwright", "screenshot", "--viewport-size", `${w},900`, `file://${snapPath}`, out],
    { cwd: root, stdio: "inherit" },
  );
}
console.log("Wrote screenshots to", outDir);
