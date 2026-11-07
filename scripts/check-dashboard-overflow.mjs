/**
 * Loads the real dashboard (built Tailwind CSS, mocked API) in headless Chromium, expands an agent
 * whose transcript has long unbroken log lines, and fails if the page or the detail panel overflows
 * horizontally at any width from 320 to 1440px.
 * Requires: pnpm build && pnpm exec playwright install chromium (playwright resolvable via NODE_PATH or
 * node_modules). Run: timeout 180 pnpm exec tsx scripts/check-dashboard-overflow.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as startTimer } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

/* global document, getComputedStyle, localStorage, window -- used inside page callbacks */

const OVERALL_TIMEOUT_MS = 150_000;
startTimer(() => {
  console.error(`check-dashboard-overflow: timed out after ${OVERALL_TIMEOUT_MS} ms`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("check-dashboard-overflow: playwright is not installed (set NODE_PATH or add it).");
  process.exit(2);
}

const builtCss = readFileSync(path.join(root, "local-runner/dist/dashboard.min.css"), "utf8");
const { runnerUiHtml } = await import(
  pathToFileURL(path.join(root, "local-runner/src/ui-html.ts")).href
);
const html = runnerUiHtml(9473, ["http://127.0.0.1:9473/"]).replace(
  /<style>[\s\S]*?<\/style>/,
  () => `<style>${builtCss}</style>`,
);

const longToken = "0123456789abcdef".repeat(40);
const longUrl = `https://example.com/artifacts/${"segment-".repeat(60)}end?query=${longToken}`;
const toolCall = (subtype, command, output) =>
  JSON.stringify({
    type: "tool_call",
    subtype,
    tool_call: {
      shellToolCall: {
        args: { command },
        ...(output ? { result: { success: { output } } } : {}),
      },
    },
  });
const longCommand = `pnpm exec some-tool --flag=${longToken} ${longUrl}`;
const logTail = [
  "--- agent (round 0) ---",
  JSON.stringify({ type: "system", subtype: "init", model: "composer-2.5" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: `Fetching ${longUrl} and hashing ${longToken}` }] },
  }),
  toolCall("started", longCommand),
  toolCall("completed", longCommand, `${longToken}\n${longUrl}\n${"x".repeat(900)}`),
  `plain-line-${longToken}`,
].join("\n");

const now = Date.now();
const job = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  createdAt: new Date(now - 60_000).toISOString(),
  updatedAt: new Date(now - 90_000).toISOString(),
  input: {
    repoPath: "/path/to/synthetic-repo",
    branch: `feat/${"very-long-branch-name-".repeat(6)}end`,
    promptFile: "/tmp/p.md",
    jobType: "code",
    title: `Synthetic agent with an extremely long title ${"word".repeat(30)}`,
    linearIssue: "ISSUE-900",
    ticketUrl: longUrl,
  },
  repoSlug: `example-org/${"synthetic-app-".repeat(5)}end`,
  stage: "failed",
  reviewRound: 1,
  maxRounds: 2,
  model: "composer-2.5-with-a-long-model-identifier",
  driverId: "cursor-agent",
  worktreePath: null,
  prUrl: "https://github.com/example-org/synthetic-app/pull/42",
  prNumber: 42,
  prIsDraft: true,
  approveHeadSha: null,
  readyPromotedAt: null,
  linearIssue: "ISSUE-900",
  ticketUrl: longUrl,
  title: `Synthetic agent with an extremely long title ${"word".repeat(30)}`,
  tokenUsage: { input: 120000, output: 40000, cacheRead: 0, cacheWrite: 0, total: 160000 },
  ciStatus: {
    status: "failure",
    summary: "checks failed",
    reason: longToken,
    source: "github",
    checkedAt: new Date(now).toISOString(),
  },
  lastVerdict: null,
  error: `synthetic failure ${longToken}`,
  logPath: "/tmp/synthetic.log",
  steerQueue: [],
  stopRequested: false,
  dryRun: false,
  archivedAt: null,
};
const issues = "https://github.com/example-org/synthetic-app/issues";
/** One ticket (with Remove), several tickets (with Remove), and no ticket (running). */
const jobs = [
  job,
  {
    ...job,
    id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    stage: "stopped",
    linearIssue: null,
    title: `#901 #902 ${job.title}`,
    ticketUrl: `${issues}/901`,
    ticketUrls: [`${issues}/901`, `${issues}/903`, longUrl],
  },
  {
    ...job,
    id: "cccccccc-dddd-eeee-ffff-000000000000",
    stage: "building",
    linearIssue: null,
    ticketUrl: null,
  },
];

const widths = [
  320, 360, 390, 414, 460, 600, 640, 700, 767, 768, 800, 900, 1000, 1023, 1024, 1100, 1280, 1440,
];
/** Also force the table layout below its breakpoint, so the table's own constraints are covered. */
const forcedTableWidths = [768, 1024];

async function newDashboardContext(browser, { forceTable }) {
  const context = await browser.newContext();
  await context.addInitScript((forceTable) => {
    localStorage.setItem("prgenie_runner_token", "synthetic-check-token");
    localStorage.setItem("prgenie_runner_show_finished", "1");
    window.EventSource = class {
      close() {}
    };
    if (!forceTable) return;
    window.matchMedia = (media) => ({
      media,
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    });
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent =
        "#jobsTableWrap{display:block!important}#jobCards{display:none!important}";
      document.head.appendChild(style);
    });
  }, forceTable);
  await context.route("http://127.0.0.1:9473/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/api/jobs/meta")
      return json({ totalOnDisk: jobs.length, mergedHidden: 0, archived: 0 });
    if (url.pathname === "/api/jobs") return json(jobs);
    const single = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (single) return json({ ...jobs.find((j) => j.id === single[1]), logTail });
    return json({});
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return { context, page };
}

async function measure(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("http://127.0.0.1:9473/");
  const toggle = page.locator(`[data-id="${job.id}"] .job-toggle`).locator("visible=true");
  await toggle.waitFor();
  const tableWidth = () =>
    Math.round(document.querySelector("table").getBoundingClientRect().width);
  const collapsedTableWidth = await page.evaluate(tableWidth);
  await toggle.click();
  await page.locator("#logSteps .agent-tool-result").waitFor({ state: "attached" });
  const ticketMenu = page.locator("#jobCards [data-ticket-menu]").locator("visible=true");
  if (await ticketMenu.count()) await ticketMenu.first().click();
  const m = await page.evaluate(() => {
    const shown = (el) => el.offsetParent !== null;
    const ticketRects = [...document.querySelectorAll("#jobCards .job-ticket")]
      .filter(shown)
      .map((el) => el.getBoundingClientRect());
    const titleLines = [...document.querySelectorAll("#jobCards .job-card-title")]
      .filter(shown)
      .map((t) =>
        Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)),
      );
    const list = [...document.querySelectorAll("#jobCards .job-ticket-list")].find(shown);
    const listRect = list && list.getBoundingClientRect();
    for (const d of document.querySelectorAll("details")) d.open = true;
    for (const id of ["logSteps", "logRaw"]) {
      const el = document.getElementById(id);
      if (getComputedStyle(el).display === "none") continue;
      el.scrollLeft = el.scrollWidth;
    }
    document.getElementById("steerPrompt").value = "x".repeat(400);
    const panel = document.querySelector("section.job-detail");
    const r = panel.getBoundingClientRect();
    const wrap = document.getElementById("jobsTableWrap");
    return {
      tableScrolls: wrap.scrollWidth > wrap.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      panelLeft: Math.round(r.left),
      panelRight: Math.round(r.right),
      expanded: [...document.querySelectorAll('.job-toggle[aria-expanded="true"]')].filter(
        (b) => b.offsetParent !== null,
      ).length,
      layout: panel.closest("tr") ? "table" : "card",
      ticketTargets: ticketRects.length,
      smallTicketTargets: ticketRects.filter((r) => r.width < 44 || r.height < 44).length,
      maxTitleLines: Math.max(0, ...titleLines),
      ticketList: listRect ? [Math.round(listRect.left), Math.round(listRect.right)] : null,
    };
  });
  return { ...m, collapsedTableWidth, expandedTableWidth: await page.evaluate(tableWidth) };
}

const failures = [];
const browser = await chromium.launch();
try {
  for (const [forceTable, list] of [
    [false, widths],
    [true, forcedTableWidths],
  ]) {
    const { context, page } = await newDashboardContext(browser, { forceTable });
    for (const width of list) {
      const m = await measure(page, width);
      // A forced table may be wider than a narrow viewport (it scrolls in its own wrapper), but
      // the expanded detail must never widen it or the page.
      const panelFits =
        forceTable || (m.panelLeft >= 0 && m.panelRight <= m.clientWidth && !m.tableScrolls);
      // Cards: a 44px icon for the one-ticket and several-ticket jobs, none for the third; titles
      // clamp at two lines; the open ticket list stays inside the viewport.
      const cardHeaderOk =
        m.layout !== "card" ||
        (m.ticketTargets === 2 &&
          m.smallTicketTargets === 0 &&
          m.maxTitleLines <= 2 &&
          m.ticketList !== null &&
          m.ticketList[0] >= 0 &&
          m.ticketList[1] <= m.clientWidth);
      const ok =
        m.scrollWidth <= m.clientWidth &&
        panelFits &&
        cardHeaderOk &&
        m.expandedTableWidth <= m.collapsedTableWidth &&
        m.expanded === 1;
      const label = `${width}px ${m.layout}${forceTable ? " (forced)" : ""}`;
      const cardInfo =
        m.layout === "card"
          ? ` tickets=${m.ticketTargets} small=${m.smallTicketTargets} titleLines<=${m.maxTitleLines} list=${JSON.stringify(m.ticketList)}`
          : "";
      console.log(
        `${ok ? "ok  " : "FAIL"} ${label}: scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} panel=[${m.panelLeft},${m.panelRight}] table=${m.collapsedTableWidth}->${m.expandedTableWidth}${cardInfo}`,
      );
      if (!ok) failures.push(label);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`check-dashboard-overflow: horizontal overflow at ${failures.join(", ")}`);
  process.exit(1);
}
console.log("check-dashboard-overflow: ok");
process.exit(0);
