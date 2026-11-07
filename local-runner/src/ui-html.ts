import { dashboardFormatBrowserScript } from "./dashboard-format.js";
import { dashboardStylesheet } from "./dashboard-styles.js";
import { streamJsonLogBrowserScript } from "./stream-json-log.js";

export function runnerUiHtml(
  port: number,
  listenUrls: string[] = [`http://127.0.0.1:${port}/`],
): string {
  const logParserInit = streamJsonLogBrowserScript();
  const dashFmtInit = dashboardFormatBrowserScript();
  const reachability = listenUrls.length ? listenUrls.join(" · ") : `http://127.0.0.1:${port}/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR Genie Local Runner</title>
  ${dashboardStylesheet()}
</head>
<body class="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
  <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-sky-800 focus:px-3 focus:py-2">Skip to content</a>
  <main id="main" class="mx-auto max-w-6xl px-3 py-4 pb-10 sm:px-5">
  <h1 class="text-xl font-semibold tracking-tight">PR Genie Local Runner</h1>
  <p class="meta text-sm leading-relaxed text-zinc-400">Runner dashboard · ${reachability} · <a class="text-sky-400 underline-offset-2 hover:underline" href="/setup">Setup</a></p>
  <div class="my-3 flex w-full flex-wrap items-end gap-2">
    <label class="block w-full text-sm text-zinc-400 sm:flex-1">Bearer token
      <input type="password" id="token" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-zinc-100" placeholder="PRGENIE_RUNNER_TOKEN" autocomplete="off" />
    </label>
    <button type="button" id="saveToken" class="min-h-11 w-full rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 text-zinc-100 sm:w-auto">Save token</button>
  </div>
  <details class="settings-panel mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" open>
    <summary class="cursor-pointer text-sm font-medium text-zinc-200 select-none">Email notifications</summary>
    <p class="meta mt-2 text-sm text-zinc-400">Resend API key is server-side only (env). Choose whether to send agent notify emails and the recipient.</p>
    <div class="mt-2 flex flex-wrap items-end gap-3">
      <label class="toggle-row flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" id="notifyEnabled" class="h-4 w-4" /> Send notify emails</label>
      <label class="block w-full flex-1 text-sm text-zinc-400 sm:min-w-[14rem]">Recipient
        <input type="email" id="notifyRecipient" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base" placeholder="you@example.com" autocomplete="email" inputmode="email" />
      </label>
      <button type="button" id="saveNotify" class="min-h-11 w-full rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 sm:w-auto">Save</button>
    </div>
    <div id="notifyStatus" class="mt-1 min-h-5 text-sm text-zinc-400" role="status" aria-live="polite"></div>
  </details>
  <section class="settings-panel mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
    <h2 class="text-base font-semibold">New agent</h2>
    <p class="meta mt-1 text-sm text-zinc-400">Start a code or docs writing agent on this runner. Docs agents use Setup defaults unless you override the repo path.</p>
    <div class="mt-2 flex flex-wrap gap-3">
      <label class="block w-full text-sm text-zinc-400 sm:w-32">Type
        <select id="newJobType" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100">
          <option value="code">Code (default)</option>
          <option value="docs">Docs / policy / marketing</option>
        </select>
      </label>
      <label class="block min-w-0 flex-1 text-sm text-zinc-400">Branch
        <input id="newJobBranch" placeholder="docs/policy-xyz" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2" />
      </label>
    </div>
    <div class="mt-2 hidden flex-wrap gap-3" id="newJobDocsRow">
      <label class="block w-full text-sm text-zinc-400">Doc template
        <select id="newJobTemplate" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2">
          <option value="marketing">Marketing copy</option>
          <option value="policy">Policy doc</option>
          <option value="research">Research brief</option>
        </select>
      </label>
    </div>
    <label class="mt-2 block text-sm text-zinc-400">Repo path override (optional)
      <input id="newJobRepo" placeholder="Local clone path on this machine" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2" />
    </label>
    <label id="newJobPromptLabel" class="mt-2 block text-sm text-zinc-400">Prompt file (code jobs)
      <input id="newJobPrompt" placeholder="/path/to/prompt.md" class="mt-1 w-full min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2" />
    </label>
    <button type="button" id="startJobBtn" class="primary mt-3 min-h-11 w-full rounded-md border border-sky-700 bg-sky-900/50 px-4 py-2 font-medium text-sky-100 sm:w-auto">Start agent</button>
    <div id="newJobStatus" class="meta mt-1 min-h-5 text-sm text-zinc-400" role="status" aria-live="polite"></div>
  </section>
  <h2 id="agentsHeading" class="text-base font-semibold">Agents</h2>
  <div class="jobs-toolbar mb-2 flex flex-wrap items-center gap-3 text-sm">
    <label class="toggle-row flex min-h-11 items-center gap-2"><input type="checkbox" id="showAllJobs" class="h-4 w-4" /> Show finished</label>
    <label class="toggle-row flex min-h-11 items-center gap-2"><input type="checkbox" id="showArchived" class="h-4 w-4" /> Show archived</label>
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" id="clearFailedBtn" class="min-h-11 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-red-100">Clear failed</button>
      <label class="toggle-row flex min-h-11 items-center gap-2"><input type="checkbox" id="clearIncludeStuck" class="h-4 w-4" /> Include stuck &amp; stopped</label>
    </div>
    <span class="meta text-zinc-500" id="jobsHiddenHint"></span>
    <span class="meta text-zinc-500" id="jobsSelectHint">Select an agent to open its transcript, steer, and stop controls.</span>
  </div>
  <div id="jobsStatus" class="meta mb-2 min-h-5 text-sm text-zinc-400 wrap-anywhere" role="status" aria-live="polite"></div>
  <div id="jobCards" class="flex min-w-0 flex-col gap-3 lg:hidden" role="list" aria-labelledby="agentsHeading"></div>
  <div id="jobsTableWrap" class="relative hidden max-w-full overflow-x-auto lg:block">
  <table class="w-full table-auto border-collapse text-sm" aria-labelledby="agentsHeading">
    <thead class="text-left text-zinc-400"><tr class="border-b border-zinc-800"><th class="p-2">Agent</th><th class="p-2">Repo</th><th class="p-2">Stage</th><th class="p-2">Round</th><th class="p-2">Ticket</th><th class="p-2">PR</th><th class="p-2">Ready</th><th class="p-2">Status</th><th class="p-2">Model</th><th class="p-2">Tokens</th><th class="p-2">Updated</th><th class="p-2"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody id="jobs"></tbody>
  </table>
  </div>
  <div id="detailHome" hidden>
  <section id="jobDetailPanel" class="job-detail flex w-full min-w-0 max-w-full flex-col rounded-lg border border-sky-900/60 bg-zinc-950/80 p-3 wrap-anywhere [contain:inline-size]" role="region" aria-labelledby="detailTitle">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 id="detailTitle" class="text-base font-semibold">Agent log</h3>
      <div id="detailStatus" class="flex flex-wrap items-center gap-2 text-sm text-zinc-400"></div>
    </div>
    <div id="docFindings" class="doc-findings mb-3 hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-3" aria-live="polite"></div>
    <div class="log-toolbar flex flex-wrap items-center gap-3 text-sm text-zinc-400">
      <label class="flex min-h-11 items-center gap-2"><input type="checkbox" id="showRaw" class="h-4 w-4" /> Raw log</label>
      <label class="flex min-h-11 items-center gap-2"><input type="checkbox" id="followLive" class="h-4 w-4" checked /> Follow live</label>
    </div>
    <div class="log-panel flex min-h-0 min-w-0 flex-1 flex-col">
      <div id="logSteps" class="max-h-[min(32rem,52vh)] min-h-32 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm lg:max-h-[min(24rem,45vh)]"></div>
      <pre id="logRaw" class="max-h-96 min-w-0 max-w-full overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs whitespace-pre-wrap wrap-anywhere"></pre>
    </div>
    <div class="chat-composer steer-panel mt-3 border-t border-zinc-800 pt-3">
      <label for="steerPrompt" class="mb-1 block text-sm text-zinc-400">Steer (queued for next agent step)</label>
      <div class="steer-row flex flex-wrap gap-2">
        <textarea id="steerPrompt" rows="2" class="min-h-14 w-full min-w-0 flex-[1_1_100%] rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base" placeholder="Add guidance… Enter to send, Shift+Enter for newline"></textarea>
        <button type="button" class="primary min-h-11 flex-1 rounded-md border border-sky-700 bg-sky-900/50 px-4 py-2 sm:flex-none" id="steerBtn">Steer</button>
        <button type="button" class="danger min-h-11 flex-1 rounded-md border border-red-800 bg-red-950/60 px-4 py-2 sm:flex-none" id="stopBtn">Stop</button>
        <button type="button" class="min-h-11 flex-1 rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 sm:flex-none" id="archiveBtn" data-action="archive" hidden>Remove</button>
      </div>
      <div id="steerStatus" class="mt-1 min-h-5 text-sm text-zinc-400" role="status" aria-live="polite"></div>
    </div>
  </section>
  </div>
  </main>
  <script>
    const logParser = ${logParserInit};
    const dashFmt = ${dashFmtInit};
    const tokenKey = "prgenie_runner_token";
    const showAllJobsKey = "prgenie_runner_show_finished";
    const showAllJobsLegacyKey = "prgenie_runner_show_all_jobs";
    const tokenEl = document.getElementById("token");
    tokenEl.value = localStorage.getItem(tokenKey) || "";
    document.getElementById("saveToken").onclick = () => {
      localStorage.setItem(tokenKey, tokenEl.value);
      refresh();
      connectListEvents();
      void loadNotifySettingsUi();
    };
    const notifyEnabledEl = document.getElementById("notifyEnabled");
    const notifyRecipientEl = document.getElementById("notifyRecipient");
    const notifyStatus = document.getElementById("notifyStatus");

    async function loadNotifySettingsUi() {
      const res = await fetch("/api/notify-settings", { headers: authHeaders() });
      if (!res.ok) {
        notifyStatus.textContent = res.status === 401 ? "Save token to edit email settings." : "Could not load email settings.";
        return;
      }
      const s = await res.json();
      notifyEnabledEl.checked = Boolean(s.enabled);
      notifyRecipientEl.value = s.recipient || "";
      const parts = [];
      if (s.envFallbackRecipient) parts.push("Env fallback: " + s.envFallbackRecipient);
      if (!s.resendConfigured) parts.push("Resend not configured on server.");
      notifyStatus.textContent = parts.join(" · ");
    }

    document.getElementById("saveNotify").onclick = async () => {
      notifyStatus.textContent = "Saving…";
      try {
        const res = await fetch("/api/notify-settings", {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({
            enabled: notifyEnabledEl.checked,
            recipient: notifyRecipientEl.value.trim() || null,
          }),
        });
        if (!res.ok) {
          notifyStatus.textContent = "Save failed (" + res.status + ").";
          return;
        }
        const s = await res.json();
        notifyEnabledEl.checked = Boolean(s.enabled);
        notifyRecipientEl.value = s.recipient || "";
        notifyStatus.textContent = "Saved.";
        void loadNotifySettingsUi();
      } catch {
        notifyStatus.textContent = "Save failed (network).";
      }
    };
    const showRawEl = document.getElementById("showRaw");
    showRawEl.checked = localStorage.getItem("prgenie_runner_show_raw") === "1";
    showRawEl.onchange = () => {
      localStorage.setItem("prgenie_runner_show_raw", showRawEl.checked ? "1" : "0");
      document.body.classList.toggle("show-raw", showRawEl.checked);
    };
    document.body.classList.toggle("show-raw", showRawEl.checked);
    const followLiveEl = document.getElementById("followLive");
    const followLiveKey = "prgenie_runner_follow_live";
    if (localStorage.getItem(followLiveKey) === "0") followLiveEl.checked = false;
    followLiveEl.onchange = () => {
      localStorage.setItem(followLiveKey, followLiveEl.checked ? "1" : "0");
    };

    const showAllJobsEl = document.getElementById("showAllJobs");
    const jobsHiddenHint = document.getElementById("jobsHiddenHint");
    if (localStorage.getItem(showAllJobsKey) === null && localStorage.getItem(showAllJobsLegacyKey) === "1") {
      localStorage.setItem(showAllJobsKey, "1");
    }
    showAllJobsEl.checked = localStorage.getItem(showAllJobsKey) === "1";
    showAllJobsEl.onchange = () => {
      localStorage.setItem(showAllJobsKey, showAllJobsEl.checked ? "1" : "0");
      void refresh();
    };
    const showArchivedKey = "prgenie_runner_show_archived";
    const showArchivedEl = document.getElementById("showArchived");
    showArchivedEl.checked = localStorage.getItem(showArchivedKey) === "1";
    showArchivedEl.onchange = () => {
      localStorage.setItem(showArchivedKey, showArchivedEl.checked ? "1" : "0");
      void refresh();
    };

    // Mirrors the server: Remove (archive) is only offered for these; building/reviewing/fixing never.
    const TERMINAL_STAGES = new Set(["approved", "failed", "stopped", "changes_remaining", "stuck"]);
    const steerEl = document.getElementById("steerPrompt");
    const steerBtn = document.getElementById("steerBtn");
    const stopBtn = document.getElementById("stopBtn");
    const archiveBtn = document.getElementById("archiveBtn");
    const steerStatus = document.getElementById("steerStatus");
    const jobsStatus = document.getElementById("jobsStatus");
    const clearFailedBtn = document.getElementById("clearFailedBtn");
    const clearIncludeStuckEl = document.getElementById("clearIncludeStuck");

    function authHeaders(json) {
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      const h = t ? { Authorization: "Bearer " + t } : {};
      if (json) h["Content-Type"] = "application/json";
      return h;
    }
    let selected = null;
    let selectedJobStage = null;
    let es = null;
    let lastJobs = [];
    let lastJobsMeta = { totalOnDisk: 0, mergedHidden: 0, archived: 0 };

    function fmtUpdated(iso) {
      const r = dashFmt.formatRelativeTime(iso, Date.now());
      return '<span title="' + r.title.replace(/"/g, "&quot;") + '">' + r.label + "</span>";
    }

    function statusLabel(job, ci) {
      return dashFmt.dashboardChecksStatusLabel(job, ci);
    }


    function fmtChecks(job, ci) {
      if (!ci) return "—";
      const label = statusLabel(job, ci);
      const cls = dashFmt.ciStatusBadgeClass(ci.status);
      const tip = ci.reason ? ' title="' + String(ci.reason).replace(/"/g, "&quot;") + '"' : "";
      const colLabel = dashFmt.isDocsJobRecord(job) ? "Doc checks" : "Status";
      const aria = ' role="status"';
      if (ci.checksUrl && !dashFmt.isDocsJobRecord(job)) {
        return '<a class="' + cls + '" href="' + ci.checksUrl + '" target="_blank" rel="noopener"' + tip + aria + ">" + label + "</a>";
      }
      return '<span class="' + cls + '"' + tip + aria + ' data-label="' + colLabel + '">' + label + '</span>';
    }

    function fmtPrDraft(j) {
      if (!j.prUrl) return "—";
      if (j.prIsDraft === true) return '<span class="' + dashFmt.PR_DRAFT_BADGE_CLASS.draft + '">Draft</span>';
      if (j.prIsDraft === false) return '<span class="' + dashFmt.PR_DRAFT_BADGE_CLASS.ready + '">Ready</span>';
      return "—";
    }

    function renderDocFindings(job) {
      const el = document.getElementById("docFindings");
      if (!job || !dashFmt.isDocsJobRecord(job) || !job.ciStatus?.findings?.length) {
        el.classList.add("hidden");
        el.innerHTML = "";
        return;
      }
      el.classList.remove("hidden");
      el.innerHTML =
        '<h3 class="text-sm font-medium text-zinc-200">Doc lint findings</h3>' +
        dashFmt.formatDocLintFindingsHtml(job.ciStatus.findings, job.ciStatus.findingsTruncated);
    }

    function fmtStatus(job, ci) {
      return fmtChecks(job, ci);
    }

    function updateSteerUi() {
      const disabled = !selected || TERMINAL_STAGES.has(selectedJobStage || "");
      steerEl.disabled = disabled;
      steerBtn.disabled = disabled;
      stopBtn.disabled = !selected || TERMINAL_STAGES.has(selectedJobStage || "");
      const picked = selected ? lastJobs.find((j) => j.id === selected) : null;
      const archived = Boolean(picked && picked.archivedAt);
      archiveBtn.hidden = !selected || (!archived && !TERMINAL_STAGES.has(selectedJobStage || ""));
      archiveBtn.dataset.action = archived ? "restore" : "archive";
      archiveBtn.textContent = archived ? "Restore" : "Remove";
    }

    function fmtTokens(u) {
      if (!u) return "—";
      const total = u.total ?? (u.input + u.output + (u.cacheRead||0) + (u.cacheWrite||0));
      if (!total) return "—";
      const compact = total >= 1000 ? (Math.round(total/100)/10) + "k" : String(total);
      const detail = "in " + (u.input||0) + ", out " + (u.output||0);
      return '<span title="' + detail + '">' + compact + "</span>";
    }

    function ticketAnchorAttrs(t) {
      return 'href="' + escapeAttr(t.url) + '" target="_blank" rel="noopener noreferrer"';
    }

    function fmtTicket(j) {
      const links = dashFmt.jobTicketLinks(j);
      if (!links.length) return j.linearIssue ? escapeAttr(j.linearIssue) : "—";
      return links
        .map((t) => '<a class="text-sky-400" ' + ticketAnchorAttrs(t) + ' aria-label="Open ticket ' + escapeAttr(t.label) + '">' + escapeAttr(t.label) + "</a>")
        .join(", ");
    }

    const TICKET_ICON =
      '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" class="size-5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M14 7v2M14 11v2M14 15v2"/></svg>';
    const TICKET_BTN_CLASS =
      "job-ticket inline-flex size-11 shrink-0 items-center justify-center gap-0.5 rounded-md border border-zinc-700 text-sky-300 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";

    /** Card header: one ticket links directly; several open a list spanning the card header. */
    function fmtCardTickets(j) {
      const links = dashFmt.jobTicketLinks(j);
      if (!links.length) return "";
      if (links.length === 1) {
        const name = "Open ticket " + escapeAttr(links[0].label);
        return '<a class="' + TICKET_BTN_CLASS + '" ' + ticketAnchorAttrs(links[0]) + ' aria-label="' + name + '" title="' + name + '">' + TICKET_ICON + "</a>";
      }
      const listId = "job-tickets-" + escapeAttr(j.id);
      const names = links.map((t) => escapeAttr(t.label)).join(", ");
      const items = links
        .map((t) => '<li><a class="flex min-h-11 flex-col justify-center rounded-md px-3 py-1 text-sky-300 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500" ' + ticketAnchorAttrs(t) + '><span class="font-medium">Open ticket ' + escapeAttr(t.label) + '</span><span class="text-xs text-zinc-400 wrap-anywhere">' + escapeAttr(t.url) + "</span></a></li>")
        .join("");
      return '<button type="button" data-ticket-menu class="' + TICKET_BTN_CLASS + '" aria-expanded="false" aria-controls="' + listId + '" aria-label="Show tickets ' + names + '" title="Tickets ' + names + '">' + TICKET_ICON + '<span aria-hidden="true" class="text-xs">' + links.length + "</span></button>" +
        '<ul id="' + listId + '" class="job-ticket-list absolute inset-x-0 top-full z-20 mt-1 grid gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-lg" hidden>' + items + "</ul>";
    }

    function setTicketMenu(btn, open) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      const list = document.getElementById(btn.getAttribute("aria-controls"));
      if (list) list.hidden = !open;
    }

    function closeTicketMenus(except) {
      for (const btn of document.querySelectorAll('[data-ticket-menu][aria-expanded="true"]')) {
        if (btn !== except) setTicketMenu(btn, false);
      }
    }

    function onTicketsClick(e) {
      const btn = e.target.closest("[data-ticket-menu]");
      if (!btn) {
        if (e.target.closest("a")) closeTicketMenus();
        return;
      }
      const open = btn.getAttribute("aria-expanded") !== "true";
      closeTicketMenus(btn);
      setTicketMenu(btn, open);
    }

    function onTicketsKeydown(e) {
      if (e.key !== "Escape") return;
      const btn = e.currentTarget.querySelector('[data-ticket-menu][aria-expanded="true"]');
      if (!btn) return;
      setTicketMenu(btn, false);
      btn.focus();
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest || !e.target.closest(".job-card-tickets")) closeTicketMenus();
    });

    let rawLogTail = "";

    function stickScrollIfNearBottom(el) {
      if (!el) return false;
      const threshold = 100;
      return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    }

    function renderLogTail(raw) {
      const stepsEl = document.getElementById("logSteps");
      const stick = followLiveEl.checked && stickScrollIfNearBottom(stepsEl);
      rawLogTail = raw || "";
      document.getElementById("logRaw").textContent = rawLogTail;
      const html = logParser.formatAgentLogTailHtml(rawLogTail);
      if (html) {
        stepsEl.innerHTML = html;
      } else if (rawLogTail && !logParser.looksLikeStreamJsonLog(rawLogTail)) {
        stepsEl.innerHTML = '<div class="agent-plain">' + rawLogTail.replace(/</g, "&lt;") + "</div>";
      } else {
        stepsEl.innerHTML = "";
      }
      if (stick) stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    function fmtRepo(j) {
      return dashFmt.jobRepoDisplayLabel(j);
    }

    function fmtAgent(j) {
      const d = dashFmt.jobAgentDisplayLabel(j);
      const tip = d.tooltip.replace(/"/g, "&quot;");
      const label = d.label.replace(/</g, "&lt;");
      let html = '<span class="agent-label inline-block max-w-[min(16rem,42vw)] truncate align-top lg:max-w-36 xl:max-w-64" title="' + tip + '">' + label + '</span>';
      if (dashFmt.isDocsJobRecord(j) && j.input && j.input.docsTemplate) {
        html += '<br><span class="meta">' + String(j.input.docsTemplate).replace(/</g, "&lt;") + '</span>';
      }
      return html;
    }

    /** Card title takes the full header width: two lines, then an ellipsis. */
    function fmtCardTitle(j) {
      const d = dashFmt.jobAgentDisplayLabel(j);
      let html = '<span class="job-card-title line-clamp-2 font-medium leading-snug wrap-anywhere" title="' + escapeAttr(d.tooltip) + '">' + escapeAttr(d.label) + "</span>";
      if (dashFmt.isDocsJobRecord(j) && j.input && j.input.docsTemplate) {
        html += '<span class="meta block text-sm">' + escapeAttr(j.input.docsTemplate) + "</span>";
      }
      return html;
    }

    function detailTitleForJob(j) {
      if (!j) return "Agent log";
      return dashFmt.jobAgentDisplayLabel(j).label;
    }

    function renderDetailHeader(j) {
      document.getElementById("detailTitle").textContent = detailTitleForJob(j);
      const stage = j
        ? '<span class="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">' + dashFmt.dashboardStageLabel(j) + "</span>"
        : "";
      setHtml(document.getElementById("detailStatus"), j ? stage + fmtStatus(j, j.ciStatus) : "");
    }

    const tbodyEl = document.getElementById("jobs");
    const cardsEl = document.getElementById("jobCards");
    const detailHome = document.getElementById("detailHome");
    const detailPanel = document.getElementById("jobDetailPanel");
    const detailRowEl = document.createElement("tr");
    detailRowEl.className = "job-detail-row";
    const detailCellEl = document.createElement("td");
    detailCellEl.colSpan = 12;
    detailCellEl.className = "job-detail-cell border-b border-zinc-800 bg-zinc-900/40 p-3";
    detailRowEl.appendChild(detailCellEl);
    // Tailwind lg: breakpoint — the 12-column table is shown at and above it, cards below it.
    const desktopMq = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 64rem)") : null;
    const rowEls = new Map();
    let panelJobId = null;

    function isDesktopLayout() {
      return desktopMq ? desktopMq.matches : true;
    }

    function detailPanelId(id) {
      return "job-detail-" + id;
    }

    function visibleToggle(els) {
      return isDesktopLayout() ? els.toggles[0] : els.toggles[1];
    }

    function setHtml(el, html) {
      if (el._prgHtml === html) return;
      el._prgHtml = html;
      el.innerHTML = html;
    }

    /** Reorder parent's children to match nodes, moving only out-of-place nodes. */
    function syncChildren(parent, nodes) {
      let cursor = parent.firstChild;
      for (const node of nodes) {
        if (node === cursor) {
          cursor = cursor.nextSibling;
          continue;
        }
        parent.insertBefore(node, cursor);
      }
      while (cursor) {
        const next = cursor.nextSibling;
        parent.removeChild(cursor);
        cursor = next;
      }
    }

    /** Moving a node in the DOM drops its focus and scroll offset; restore both. */
    function keepFocusAndScroll(fn) {
      const active = document.activeElement;
      let selStart = null;
      let selEnd = null;
      try {
        if (active && typeof active.selectionStart === "number") {
          selStart = active.selectionStart;
          selEnd = active.selectionEnd;
        }
      } catch {}
      const scrollers = [document.getElementById("logSteps"), document.getElementById("logRaw")];
      const offsets = scrollers.map((el) => el.scrollTop);
      fn();
      scrollers.forEach((el, i) => {
        if (el.scrollTop !== offsets[i]) el.scrollTop = offsets[i];
      });
      if (active && active !== document.body && active.isConnected && document.activeElement !== active) {
        active.focus({ preventScroll: true });
        if (selStart !== null) {
          try { active.setSelectionRange(selStart, selEnd); } catch {}
        }
      }
    }

    const TOGGLE_CLASS =
      "job-toggle group flex min-h-11 w-full min-w-0 items-start gap-2 rounded-md text-left text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";
    const TOGGLE_INNER =
      '<span aria-hidden="true" class="job-chevron mt-0.5 inline-block w-3 shrink-0 text-zinc-500 transition-transform group-aria-expanded:rotate-90 group-aria-expanded:text-sky-400">▸</span><span class="job-toggle-label min-w-0 flex-1"></span>';
    const CELL_LABELS = ["Agent", "Repo", "Stage", "Round", "Ticket", "PR", "Ready", "Status", "Model", "Tokens", "Updated", "Actions"];
    const ACTIONS_CELL = CELL_LABELS.length - 1;
    const ACTION_BTN_CLASS =
      "job-action min-h-11 rounded-md border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";

    function escapeAttr(s) {
      return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

    /** Remove for terminal or queued jobs, Restore for archived ones, nothing while running. */
    function fmtActions(j) {
      const label = escapeAttr(dashFmt.jobAgentDisplayLabel(j).label);
      if (j.archivedAt) {
        return '<button type="button" data-action="restore" class="' + ACTION_BTN_CLASS + ' border-zinc-600 bg-zinc-800 text-zinc-100" aria-label="Restore ' + label + '">Restore</button>';
      }
      const queued = Boolean(j.queueState && j.queueState.queued);
      if (!TERMINAL_STAGES.has(j.stage) && !queued) return "";
      return '<button type="button" data-action="archive" class="' + ACTION_BTN_CLASS + ' border-red-900 bg-red-950/40 text-red-100" aria-label="Remove ' + label + '">Remove</button>';
    }

    function onActionClick(e, id) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.action === "restore") void restoreJobUi(id);
      else void archiveJobUi(id);
    }

    function createJobEls(id) {
      const tr = document.createElement("tr");
      tr.className = "job-row cursor-pointer border-b border-zinc-800 hover:bg-zinc-900/80";
      tr.dataset.id = id;
      tr.innerHTML = CELL_LABELS.map((label, i) => {
        const cls = i === 1 ? "meta p-2 text-zinc-400" : "p-2";
        const inner = i === 0 ? '<button type="button" class="' + TOGGLE_CLASS + '">' + TOGGLE_INNER + "</button>" : "";
        return '<td class="' + cls + '" data-label="' + label + '">' + inner + "</td>";
      }).join("");
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a, button, input, textarea, select, summary, label")) return;
        toggleJob(id);
      });
      const card = document.createElement("div");
      card.className = "job-row job-card rounded-xl border border-zinc-800 bg-zinc-900/50 p-3";
      card.setAttribute("role", "listitem");
      card.dataset.id = id;
      card.innerHTML =
        '<div class="job-card-header relative flex items-start gap-2"><button type="button" class="' + TOGGLE_CLASS + '">' + TOGGLE_INNER + '</button><div class="job-card-tickets flex shrink-0 empty:hidden"></div><div class="job-card-actions shrink-0 empty:hidden"></div></div>' +
        '<details class="job-card-more mt-2 text-sm text-zinc-300"><summary class="cursor-pointer text-zinc-500">More</summary><div class="job-card-meta mt-2 grid gap-1"></div></details>';
      const toggles = [tr.querySelector(".job-toggle"), card.querySelector(".job-toggle")];
      toggles.forEach((b) => b.addEventListener("click", () => toggleJob(id)));
      const cells = [...tr.children];
      const cardActions = card.querySelector(".job-card-actions");
      const cardTickets = card.querySelector(".job-card-tickets");
      cells[ACTIONS_CELL].addEventListener("click", (e) => onActionClick(e, id));
      cardActions.addEventListener("click", (e) => onActionClick(e, id));
      cardTickets.addEventListener("click", onTicketsClick);
      cardTickets.addEventListener("keydown", onTicketsKeydown);
      return {
        tr,
        cells,
        card,
        toggles,
        cardLabel: card.querySelector(".job-toggle-label"),
        cardMeta: card.querySelector(".job-card-meta"),
        cardActions,
        cardTickets,
      };
    }

    function updateJobEls(els, j) {
      const stageLabel = dashFmt.dashboardStageLabel(j);
      const pr = j.prUrl ? '<a class="text-sky-400" href="' + j.prUrl + '" target="_blank" rel="noopener">PR</a>' : "—";
      const archivedBadge = j.archivedAt
        ? ' <span class="job-archived-badge ml-1 rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">Archived</span>'
        : "";
      const values = [
        fmtAgent(j) + archivedBadge,
        fmtRepo(j),
        stageLabel,
        j.reviewRound + "/" + j.maxRounds,
        fmtTicket(j),
        pr,
        fmtPrDraft(j),
        fmtStatus(j, j.ciStatus),
        j.model || "—",
        fmtTokens(j.tokenUsage),
        fmtUpdated(j.updatedAt),
        fmtActions(j),
      ];
      setHtml(els.cells[0].querySelector(".job-toggle-label"), values[0]);
      for (let i = 1; i < values.length; i++) setHtml(els.cells[i], values[i]);
      setHtml(els.cardActions, values[ACTIONS_CELL]);
      els.tr.classList.toggle("opacity-60", Boolean(j.archivedAt));
      els.card.classList.toggle("opacity-60", Boolean(j.archivedAt));
      els.cells[7].dataset.label = dashFmt.isDocsJobRecord(j) ? "Doc checks" : "Status";
      setHtml(
        els.cardLabel,
        fmtCardTitle(j) + '<span class="meta mt-1 block text-sm text-zinc-400 wrap-anywhere">' + values[1] + " · " + stageLabel + archivedBadge + "</span>",
      );
      setHtml(els.cardTickets, fmtCardTickets(j));
      setHtml(els.cardMeta, pr + " · " + values[6] + " · " + values[7]);
    }

    function syncSelectionUi() {
      for (const [id, els] of rowEls) {
        const on = id === selected;
        for (const b of els.toggles) {
          b.setAttribute("aria-expanded", on ? "true" : "false");
          b.setAttribute("aria-controls", detailPanelId(id));
        }
        els.tr.classList.toggle("bg-zinc-800/80", on);
        els.tr.classList.toggle("hover:bg-zinc-900/80", !on);
        els.card.classList.toggle("ring-2", on);
        els.card.classList.toggle("ring-sky-600/50", on);
      }
    }

    /** Attach the single detail panel under the selected row (table) or inside its card. */
    function placeDetail() {
      const els = selected ? rowEls.get(selected) : null;
      if (!els) {
        if (detailRowEl.parentNode) detailRowEl.remove();
        if (detailPanel.parentNode !== detailHome) detailHome.appendChild(detailPanel);
        detailPanel.id = "jobDetailPanel";
        delete detailRowEl.dataset.detailFor;
        return;
      }
      detailPanel.id = detailPanelId(selected);
      if (isDesktopLayout()) {
        detailRowEl.dataset.detailFor = selected;
        if (els.tr.nextSibling !== detailRowEl) els.tr.after(detailRowEl);
        if (detailPanel.parentNode !== detailCellEl) detailCellEl.appendChild(detailPanel);
      } else {
        if (detailRowEl.parentNode) detailRowEl.remove();
        delete detailRowEl.dataset.detailFor;
        if (detailPanel.parentNode !== els.card) els.card.appendChild(detailPanel);
      }
      detailPanel.classList.toggle("mt-3", !isDesktopLayout());
    }

    function showJobsMessage(html) {
      rowEls.clear();
      placeDetail();
      tbodyEl.innerHTML = '<tr><td colspan="12" class="empty-state p-3 text-zinc-400">' + html + "</td></tr>";
      cardsEl.innerHTML = '<div role="listitem" class="empty-state rounded-xl border border-zinc-800 p-3 text-sm text-zinc-400">' + html + "</div>";
    }

    /** A removed row (e.g. its Remove button was focused) must not drop focus to <body>. */
    function renderJobTable(jobs) {
      const active = document.activeElement;
      renderJobList(jobs);
      const now = document.activeElement;
      if (active && active !== document.body && (!now || now === document.body)) {
        showAllJobsEl.focus({ preventScroll: true });
      }
    }

    function renderJobList(jobs) {
      const showFinished = showAllJobsEl.checked;
      const isStale = (j) => !j.archivedAt && dashFmt.shouldHideStaleJob(j);
      const staleHidden = showFinished ? 0 : jobs.filter(isStale).length;
      const visible = showFinished ? jobs : jobs.filter((j) => !isStale(j));
      const hintParts = [];
      if (!showFinished && lastJobsMeta.mergedHidden > 0) {
        hintParts.push("(" + lastJobsMeta.mergedHidden + " finished hidden)");
      }
      if (staleHidden > 0) hintParts.push("(" + staleHidden + " stale hidden)");
      if (!showArchivedEl.checked && lastJobsMeta.archived > 0) {
        hintParts.push("(" + lastJobsMeta.archived + " archived)");
      }
      jobsHiddenHint.textContent = hintParts.join(" ");
      if (!visible.length) {
        if (selected) collapseDetail();
        let msg;
        if (jobs.length === 0 && lastJobsMeta.totalOnDisk === 0) {
          msg = "<strong>No agents yet.</strong> Start an agent below or from MCP.";
        } else if (jobs.length === 0 && lastJobsMeta.mergedHidden > 0) {
          msg =
            "<strong>Finished agents are hidden.</strong> Turn on <em>Show finished</em> to see " +
            lastJobsMeta.mergedHidden +
            " finished agent(s).";
        } else {
          msg =
            "No agents match the current filter. Turn on <em>Show finished</em> to include finished and stale rows.";
        }
        showJobsMessage(msg);
        return;
      }
      const visibleIds = new Set(visible.map((j) => j.id));
      for (const id of [...rowEls.keys()]) {
        if (!visibleIds.has(id)) rowEls.delete(id);
      }
      if (selected && !visibleIds.has(selected)) collapseDetail();
      const desktop = isDesktopLayout();
      keepFocusAndScroll(() => {
        const rows = [];
        const cards = [];
        for (const j of visible) {
          let els = rowEls.get(j.id);
          if (!els) {
            els = createJobEls(j.id);
            rowEls.set(j.id, els);
          }
          updateJobEls(els, j);
          rows.push(els.tr);
          if (j.id === selected && desktop) rows.push(detailRowEl);
          cards.push(els.card);
        }
        syncChildren(tbodyEl, rows);
        syncChildren(cardsEl, cards);
        placeDetail();
      });
      syncSelectionUi();
      if (selected) {
        const picked = visible.find((j) => j.id === selected);
        selectedJobStage = picked?.stage ?? selectedJobStage;
        renderDetailHeader(picked);
      }
      updateSteerUi();
    }

    let refreshSeq = 0;
    async function refresh() {
      const seq = ++refreshSeq;
      const metaRes = await fetch("/api/jobs/meta", { headers: authHeaders() });
      if (metaRes.ok) {
        lastJobsMeta = await metaRes.json();
      }
      const params = [];
      if (showAllJobsEl.checked) params.push("includeFinished=1");
      if (showArchivedEl.checked) params.push("includeArchived=1");
      const jobsPath = "/api/jobs" + (params.length ? "?" + params.join("&") : "");
      const res = await fetch(jobsPath, { headers: authHeaders() });
      if (seq !== refreshSeq) return;
      if (res.status === 401) {
        showJobsMessage("<strong>Unauthorized.</strong> Paste your runner bearer token above and click Save token.");
        lastJobs = [];
        return;
      }
      if (!res.ok) {
        showJobsMessage("Could not reach the runner (" + res.status + "). Check that serve is running.");
        lastJobs = [];
        return;
      }
      const jobs = await res.json();
      if (seq !== refreshSeq) return;
      lastJobs = jobs;
      renderJobTable(lastJobs);
    }

    function toggleJob(id) {
      if (selected === id) collapseDetail();
      else selectJob(id);
    }

    function selectJob(id) {
      const prevEls = rowEls.get(id);
      const anchor = prevEls ? visibleToggle(prevEls) : null;
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      selected = id;
      steerStatus.textContent = "";
      const picked = lastJobs.find((j) => j.id === id);
      selectedJobStage = picked ? picked.stage : null;
      if (panelJobId !== id) {
        panelJobId = id;
        steerEl.value = "";
        renderLogTail("");
        renderDocFindings(null);
      }
      renderDetailHeader(picked);
      keepFocusAndScroll(placeDetail);
      syncSelectionUi();
      updateSteerUi();
      if (anchor) {
        const shift = anchor.getBoundingClientRect().top - anchorTop;
        if (shift) window.scrollBy(0, shift);
      }
      if (es) es.close();
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      const stream = new EventSource("/api/jobs/" + id + "/stream?token=" + encodeURIComponent(t || ""));
      es = stream;
      stream.onmessage = (ev) => {
        if (es !== stream || selected !== id) return;
        const data = JSON.parse(ev.data);
        if (data.logTail !== undefined) renderLogTail(data.logTail);
        if (data.stage) {
          selectedJobStage = data.stage;
          updateSteerUi();
          refresh();
        }
      };
      fetch("/api/jobs/" + id, { headers: authHeaders() }).then(r => r.json()).then(j => {
        if (selected !== id) return;
        selectedJobStage = j.stage;
        updateSteerUi();
        renderDetailHeader(j);
        renderLogTail(j.logTail || "");
        renderDocFindings(j);
      });
    }

    function collapseDetail() {
      const id = selected;
      const focusWasInPanel = detailPanel.contains(document.activeElement);
      selected = null;
      selectedJobStage = null;
      if (es) { es.close(); es = null; }
      placeDetail();
      syncSelectionUi();
      updateSteerUi();
      if (focusWasInPanel) {
        const els = id ? rowEls.get(id) : null;
        (els ? visibleToggle(els) : showAllJobsEl).focus();
      }
    }

    detailPanel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && selected) {
        e.preventDefault();
        collapseDetail();
      }
    });

    const onLayoutChange = () => {
      if (rowEls.size && lastJobs.length) renderJobTable(lastJobs);
    };
    if (desktopMq && desktopMq.addEventListener) desktopMq.addEventListener("change", onLayoutChange);
    else if (desktopMq && desktopMq.addListener) desktopMq.addListener(onLayoutChange);

    async function steerJob() {
      const prompt = steerEl.value.trim();
      if (!prompt || !selected || steerBtn.disabled) return;
      steerStatus.textContent = "Sending…";
      try {
        const res = await fetch("/api/jobs/" + selected + "/steer", {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          steerStatus.textContent = "Steer failed (" + res.status + ").";
          return;
        }
        steerEl.value = "";
        steerStatus.textContent = "Queued for next agent step.";
      } catch {
        steerStatus.textContent = "Steer failed (network).";
      }
    }

    async function stopJob() {
      if (!selected || stopBtn.disabled) return;
      steerStatus.textContent = "Stopping…";
      try {
        const res = await fetch("/api/jobs/" + selected + "/stop", { method: "POST", headers: authHeaders() });
        steerStatus.textContent = res.ok ? "Stop requested." : "Stop failed (" + res.status + ").";
        if (res.ok) refresh();
      } catch {
        steerStatus.textContent = "Stop failed (network).";
      }
    }

    function jobLabelFor(id) {
      const j = lastJobs.find((x) => x.id === id);
      return j ? dashFmt.jobAgentDisplayLabel(j).label : id.slice(0, 8);
    }

    async function postJobAction(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: authHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    }

    async function archiveJobUi(id) {
      const label = jobLabelFor(id);
      const ok = window.confirm(
        'Remove "' + label + '" from the dashboard? Its job record and log move to the archive (use Show archived to restore). A clean worktree is deleted; one with uncommitted changes is kept.',
      );
      if (!ok) return;
      jobsStatus.textContent = "Removing…";
      try {
        const { res, data } = await postJobAction("/api/jobs/" + encodeURIComponent(id) + "/archive");
        if (!res.ok) {
          jobsStatus.textContent = "Remove failed: " + (data.error || res.status) + ".";
          return;
        }
        jobsStatus.textContent = 'Removed "' + label + '".' + (data.warning ? " " + data.warning : "");
      } catch {
        jobsStatus.textContent = "Remove failed (network).";
        return;
      }
      await refresh();
    }

    async function restoreJobUi(id) {
      const label = jobLabelFor(id);
      jobsStatus.textContent = "Restoring…";
      try {
        const { res, data } = await postJobAction("/api/jobs/" + encodeURIComponent(id) + "/restore");
        if (!res.ok) {
          jobsStatus.textContent = "Restore failed: " + (data.error || res.status) + ".";
          return;
        }
        jobsStatus.textContent = 'Restored "' + label + '".';
      } catch {
        jobsStatus.textContent = "Restore failed (network).";
        return;
      }
      await refresh();
    }

    async function clearFailedUi() {
      const includeStuckStopped = clearIncludeStuckEl.checked;
      const stages = includeStuckStopped ? ["failed", "stuck", "stopped"] : ["failed"];
      const count = lastJobs.filter((j) => !j.archivedAt && stages.includes(j.stage)).length;
      const what = includeStuckStopped ? "failed, stuck, or stopped" : "failed";
      if (!count) {
        jobsStatus.textContent = "No " + what + " agents to clear.";
        return;
      }
      const ok = window.confirm(
        "Remove " + count + " " + what + " agent(s) from the dashboard? They move to the archive. Clean worktrees are deleted; ones with uncommitted changes are kept.",
      );
      if (!ok) return;
      jobsStatus.textContent = "Clearing…";
      try {
        const { res, data } = await postJobAction("/api/jobs/clear-failed", { includeStuckStopped });
        if (!res.ok) {
          jobsStatus.textContent = "Clear failed: " + (data.error || res.status) + ".";
          return;
        }
        const parts = ["Removed " + (data.archived || []).length + " agent(s)."];
        for (const w of data.warnings || []) parts.push(w.warning);
        if ((data.skipped || []).length) parts.push(data.skipped.length + " skipped (still running).");
        jobsStatus.textContent = parts.join(" ");
      } catch {
        jobsStatus.textContent = "Clear failed (network).";
        return;
      }
      await refresh();
    }

    let listEs = null;
    /** Other dashboards archive/restore/start jobs; refresh the list when the server says so. */
    function connectListEvents() {
      if (listEs) listEs.close();
      listEs = null;
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      if (!t || typeof EventSource !== "function") return;
      const stream = new EventSource("/api/events?token=" + encodeURIComponent(t));
      listEs = stream;
      stream.onmessage = () => {
        if (listEs === stream) void refresh();
      };
    }

    steerBtn.onclick = () => void steerJob();
    stopBtn.onclick = () => void stopJob();
    archiveBtn.onclick = () => {
      if (!selected) return;
      if (archiveBtn.dataset.action === "restore") void restoreJobUi(selected);
      else void archiveJobUi(selected);
    };
    clearFailedBtn.onclick = () => void clearFailedUi();
    steerEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void steerJob();
      }
    });

    const newJobTypeEl = document.getElementById("newJobType");
    const newJobDocsRow = document.getElementById("newJobDocsRow");
    const newJobPromptLabel = document.getElementById("newJobPromptLabel");
    const newJobPromptEl = document.getElementById("newJobPrompt");
    const newJobStatus = document.getElementById("newJobStatus");

    function syncNewJobForm() {
      const docs = newJobTypeEl.value === "docs";
      newJobDocsRow.style.display = docs ? "flex" : "none";
      newJobDocsRow.classList.toggle("hidden", !docs);
      newJobPromptLabel.textContent = docs ? "Prompt file (optional — uses template if empty)" : "Prompt file (code jobs)";
      newJobPromptEl.required = !docs;
    }
    newJobTypeEl.onchange = syncNewJobForm;
    syncNewJobForm();

    document.getElementById("startJobBtn").onclick = async () => {
      newJobStatus.textContent = "Starting…";
      const jobType = newJobTypeEl.value;
      const body = {
        branch: document.getElementById("newJobBranch").value.trim(),
        jobType,
        repoPath: document.getElementById("newJobRepo").value.trim() || undefined,
      };
      if (jobType === "docs") {
        body.docsTemplate = document.getElementById("newJobTemplate").value;
        if (newJobPromptEl.value.trim()) body.promptFile = newJobPromptEl.value.trim();
      } else {
        body.promptFile = newJobPromptEl.value.trim();
      }
      if (!body.branch) {
        newJobStatus.textContent = "Branch is required.";
        return;
      }
      if (jobType === "code" && !body.promptFile) {
        newJobStatus.textContent = "Prompt file is required for code jobs.";
        return;
      }
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          newJobStatus.textContent = data.error || "Start failed (" + res.status + ").";
          return;
        }
        newJobStatus.textContent = "Job started: " + (data.id || "").slice(0, 8);
        void refresh();
      } catch {
        newJobStatus.textContent = "Start failed (network).";
      }
    };

    updateSteerUi();
    refresh();
    connectListEvents();
    void loadNotifySettingsUi();
    setInterval(refresh, 8000);
    setInterval(() => { if (lastJobs.length) renderJobTable(lastJobs); }, 30000);
  </script>
</body>
</html>`;
}
