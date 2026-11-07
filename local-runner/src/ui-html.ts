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
  <div class="jobs-toolbar mb-2 flex flex-wrap items-center gap-3 text-sm">
    <label class="toggle-row flex min-h-11 items-center gap-2"><input type="checkbox" id="showAllJobs" class="h-4 w-4" /> Show finished</label>
    <span class="meta text-zinc-500" id="jobsHiddenHint"></span>
  </div>
  <div id="jobCards" class="flex flex-col gap-3 md:hidden" role="list" aria-label="Agents"></div>
  <div class="hidden overflow-x-auto md:block">
  <table class="w-full border-collapse text-sm">
    <thead class="text-left text-zinc-400"><tr class="border-b border-zinc-800"><th class="p-2">Agent</th><th class="p-2">Repo</th><th class="p-2">Stage</th><th class="p-2">Round</th><th class="p-2">Ticket</th><th class="p-2">PR</th><th class="p-2">Ready</th><th class="p-2">Status</th><th class="p-2">Model</th><th class="p-2">Tokens</th><th class="p-2">Updated</th></tr></thead>
    <tbody id="jobs"></tbody>
  </table>
  </div>
  <h2 id="detailTitle" class="mt-6 text-base font-semibold">Agent log</h2>
  <p class="log-placeholder text-sm text-zinc-400" id="logPlaceholder">Select an agent to view its transcript.</p>
  <div class="detail-chat mt-2 flex flex-col" id="detailChat" style="display:none;">
    <div id="docFindings" class="doc-findings mb-3 hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-3" aria-live="polite"></div>
    <div class="log-toolbar flex flex-wrap items-center gap-3 text-sm text-zinc-400">
      <label class="flex min-h-11 items-center gap-2"><input type="checkbox" id="showRaw" class="h-4 w-4" /> Raw log</label>
      <label class="flex min-h-11 items-center gap-2"><input type="checkbox" id="followLive" class="h-4 w-4" checked /> Follow live</label>
    </div>
    <div class="log-panel flex min-h-0 flex-1 flex-col">
      <div id="logSteps" class="max-h-[min(32rem,52vh)] min-h-32 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm md:max-h-[min(24rem,45vh)]"></div>
      <pre id="logRaw" class="max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs whitespace-pre-wrap break-words"></pre>
    </div>
    <div class="chat-composer steer-panel mt-3 border-t border-zinc-800 pt-3">
      <label for="steerPrompt" class="mb-1 block text-sm text-zinc-400">Steer (queued for next agent step)</label>
      <div class="steer-row flex flex-wrap gap-2">
        <textarea id="steerPrompt" rows="2" class="min-h-14 w-full flex-[1_1_100%] rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base" placeholder="Add guidance… Enter to send, Shift+Enter for newline"></textarea>
        <button type="button" class="primary min-h-11 flex-1 rounded-md border border-sky-700 bg-sky-900/50 px-4 py-2 sm:flex-none" id="steerBtn">Steer</button>
        <button type="button" class="danger min-h-11 flex-1 rounded-md border border-red-800 bg-red-950/60 px-4 py-2 sm:flex-none" id="stopBtn">Stop</button>
      </div>
      <div id="steerStatus" class="mt-1 min-h-5 text-sm text-zinc-400" role="status" aria-live="polite"></div>
    </div>
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

    const TERMINAL_STAGES = new Set(["approved", "failed", "stopped", "changes_remaining"]);
    const steerEl = document.getElementById("steerPrompt");
    const steerBtn = document.getElementById("steerBtn");
    const stopBtn = document.getElementById("stopBtn");
    const steerStatus = document.getElementById("steerStatus");

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
    let lastJobsMeta = { totalOnDisk: 0, mergedHidden: 0 };

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
    }

    function updateDetailVisibility() {
      const hasJob = Boolean(selected);
      document.getElementById("logPlaceholder").style.display = hasJob ? "none" : "block";
      document.getElementById("detailChat").style.display = hasJob ? "flex" : "none";
      if (!hasJob) {
        document.getElementById("detailTitle").textContent = "Agent log";
        renderLogTail("");
      }
    }

    function fmtTokens(u) {
      if (!u) return "—";
      const total = u.total ?? (u.input + u.output + (u.cacheRead||0) + (u.cacheWrite||0));
      if (!total) return "—";
      const compact = total >= 1000 ? (Math.round(total/100)/10) + "k" : String(total);
      const detail = "in " + (u.input||0) + ", out " + (u.output||0);
      return '<span title="' + detail + '">' + compact + "</span>";
    }

    function fmtTicket(j) {
      if (j.ticketUrl && j.linearIssue) return '<a href="' + j.ticketUrl + '" target="_blank" rel="noopener">' + j.linearIssue + "</a>";
      if (j.ticketUrl) return '<a href="' + j.ticketUrl + '" target="_blank" rel="noopener">ticket</a>';
      return "—";
    }

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
      let html = '<span class="agent-label inline-block max-w-[min(16rem,42vw)] truncate align-top" title="' + tip + '">' + label + '</span>';
      if (dashFmt.isDocsJobRecord(j) && j.input && j.input.docsTemplate) {
        html += '<br><span class="meta">' + String(j.input.docsTemplate).replace(/</g, "&lt;") + '</span>';
      }
      return html;
    }

    function detailTitleForJob(j) {
      if (!j) return "Agent log";
      return dashFmt.jobAgentDisplayLabel(j).label;
    }

    function renderJobTable(jobs) {
      const showFinished = showAllJobsEl.checked;
      const staleHidden = showFinished ? 0 : jobs.filter((j) => dashFmt.shouldHideStaleJob(j)).length;
      const visible = showFinished ? jobs : jobs.filter((j) => !dashFmt.shouldHideStaleJob(j));
      const hintParts = [];
      if (!showFinished && lastJobsMeta.mergedHidden > 0) {
        hintParts.push("(" + lastJobsMeta.mergedHidden + " finished hidden)");
      }
      if (staleHidden > 0) hintParts.push("(" + staleHidden + " stale hidden)");
      jobsHiddenHint.textContent = hintParts.join(" ");
      const tbody = document.getElementById("jobs");
      const cardsEl = document.getElementById("jobCards");
      if (!visible.length) {
        cardsEl.innerHTML = "";
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
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">' + msg + "</td></tr>";
        return;
      }
      function bindJobRow(el, id) {
        el.dataset.id = id;
        el.classList.add("job-row");
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.onclick = () => selectJob(id);
        el.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectJob(id);
          }
        };
      }
      tbody.innerHTML = visible.map(j => {
        const stageLabel = dashFmt.dashboardStageLabel(j);
        const sel = j.id === selected ? " bg-zinc-800/80 ring-1 ring-sky-600/40" : " hover:bg-zinc-900/80";
        const checksLabel = dashFmt.isDocsJobRecord(j) ? "Doc checks" : "Status";
        return \`<tr class="job-row cursor-pointer border-b border-zinc-800\${sel}" data-id="\${j.id}" tabindex="0" role="button">
        <td class="p-2" data-label="Agent">\${fmtAgent(j)}</td>
        <td class="meta p-2 text-zinc-400" data-label="Repo">\${fmtRepo(j)}</td>
        <td class="p-2" data-label="Stage">\${stageLabel}</td>
        <td class="p-2" data-label="Round">\${j.reviewRound}/\${j.maxRounds}</td>
        <td class="p-2" data-label="Ticket">\${fmtTicket(j)}</td>
        <td class="p-2" data-label="PR">\${j.prUrl ? '<a class="text-sky-400" href="'+j.prUrl+'" target="_blank" rel="noopener">PR</a>' : "—"}</td>
        <td class="p-2" data-label="Ready">\${fmtPrDraft(j)}</td>
        <td class="p-2" data-label="\${checksLabel}">\${fmtStatus(j, j.ciStatus)}</td>
        <td class="p-2" data-label="Model">\${j.model || "—"}</td>
        <td class="p-2" data-label="Tokens">\${fmtTokens(j.tokenUsage)}</td>
        <td class="p-2" data-label="Updated">\${fmtUpdated(j.updatedAt)}</td>
      </tr>\`;
      }).join("");
      cardsEl.innerHTML = visible.map(j => {
        const stageLabel = dashFmt.dashboardStageLabel(j);
        const sel = j.id === selected ? " ring-2 ring-sky-600/50" : "";
        return \`<article class="job-row rounded-xl border border-zinc-800 bg-zinc-900/50 p-3\${sel}">
          <div class="font-medium leading-snug">\${fmtAgent(j)}</div>
          <div class="meta mt-1 text-sm text-zinc-400">\${fmtRepo(j)} · \${stageLabel}</div>
          <details class="mt-2 text-sm text-zinc-300"><summary class="cursor-pointer text-zinc-500">More</summary>
            <div class="mt-2 grid gap-1">\${fmtTicket(j)} · \${fmtPrDraft(j)} · \${fmtStatus(j, j.ciStatus)}</div>
          </details>
        </article>\`;
      }).join("");
      tbody.querySelectorAll("tr.job-row").forEach(tr => bindJobRow(tr, tr.dataset.id));
      cardsEl.querySelectorAll(".job-row").forEach(card => bindJobRow(card, card.dataset.id));
      if (selected) {
        const row = tbody.querySelector('tr[data-id="' + selected + '"]');
        if (row) {
          selectedJobStage = jobs.find(j => j.id === selected)?.stage ?? selectedJobStage;
        } else if (!visible.some(j => j.id === selected)) {
          selected = null;
          selectedJobStage = null;
          if (es) { es.close(); es = null; }
          updateDetailVisibility();
        }
      }
      updateSteerUi();
    }

    async function refresh() {
      const metaRes = await fetch("/api/jobs/meta", { headers: authHeaders() });
      if (metaRes.ok) {
        lastJobsMeta = await metaRes.json();
      }
      const jobsPath = showAllJobsEl.checked ? "/api/jobs?includeFinished=1" : "/api/jobs";
      const res = await fetch(jobsPath, { headers: authHeaders() });
      const tbody = document.getElementById("jobs");
      if (res.status === 401) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><strong>Unauthorized.</strong> Paste your runner bearer token above and click Save token.</td></tr>';
        lastJobs = [];
        return;
      }
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Could not reach the runner (' + res.status + "). Check that serve is running.</td></tr>";
        lastJobs = [];
        return;
      }
      lastJobs = await res.json();
      renderJobTable(lastJobs);
    }

    function selectJob(id) {
      selected = id;
      steerStatus.textContent = "";
      const picked = lastJobs.find((j) => j.id === id);
      document.getElementById("detailTitle").textContent = detailTitleForJob(picked);
      updateDetailVisibility();
      document.querySelectorAll(".job-row").forEach(el => {
        const on = el.dataset.id === id;
        if (el.tagName === "TR") {
          el.classList.toggle("bg-zinc-800/80", on);
          el.classList.toggle("ring-1", on);
        } else {
          el.classList.toggle("ring-2", on);
          el.classList.toggle("ring-sky-600/50", on);
        }
      });
      if (es) es.close();
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      es = new EventSource("/api/jobs/" + id + "/stream?token=" + encodeURIComponent(t || ""));
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.logTail !== undefined) renderLogTail(data.logTail);
        if (data.stage) {
          selectedJobStage = data.stage;
          updateSteerUi();
          refresh();
        }
      };
      fetch("/api/jobs/" + id, { headers: authHeaders() }).then(r => r.json()).then(j => {
        selectedJobStage = j.stage;
        updateSteerUi();
        document.getElementById("detailTitle").textContent = detailTitleForJob(j);
        renderLogTail(j.logTail || "");
        renderDocFindings(j);
      });
    }

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

    steerBtn.onclick = () => void steerJob();
    stopBtn.onclick = () => void stopJob();
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
    updateDetailVisibility();
    refresh();
    void loadNotifySettingsUi();
    setInterval(refresh, 8000);
    setInterval(() => { if (lastJobs.length) renderJobTable(lastJobs); }, 30000);
  </script>
</body>
</html>`;
}
