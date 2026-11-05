import { dashboardFormatBrowserScript } from "./dashboard-format.js";
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
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 1rem 1.25rem 2rem; background: #0f1115; color: #e6e8ec; max-width: 72rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.35rem; }
    h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #333; font-size: 0.85rem; vertical-align: top; }
    tr.job-row { cursor: pointer; }
    tr.job-row.selected { background: #1e2430; }
    tr.job-row:hover { background: #181c24; }
    .badge { font-size: 0.75rem; padding: 0.2rem 0.45rem; border-radius: 999px; display: inline-block; font-weight: 500; border: 1px solid transparent; }
    .badge.success { color: #6fdc8c; background: rgba(46, 125, 70, 0.22); border-color: rgba(111, 220, 140, 0.35); }
    .badge.failure { color: #ff8a8a; background: rgba(140, 50, 50, 0.25); border-color: rgba(255, 138, 138, 0.35); }
    .badge.pending { color: #e8d878; background: rgba(120, 100, 30, 0.28); border-color: rgba(201, 180, 88, 0.4); }
    .badge.neutral, .badge.unknown { color: #b0b8c4; background: rgba(80, 88, 100, 0.35); border-color: rgba(154, 163, 178, 0.35); }
    .badge.merged { color: #c4e4ff; background: rgba(60, 100, 140, 0.35); border-color: rgba(154, 208, 255, 0.4); }
    .badge.merge_conflict { color: #ffb86c; background: rgba(120, 70, 30, 0.3); border-color: rgba(255, 184, 108, 0.4); }
    .badge.closed { color: #c8b8e8; background: rgba(80, 60, 110, 0.35); border-color: rgba(180, 160, 220, 0.35); }
    .badge.draft { color: #c9d4e8; background: rgba(70, 85, 110, 0.35); border-color: rgba(160, 180, 220, 0.35); }
    .badge.ready { color: #8fd4a8; background: rgba(40, 90, 60, 0.3); border-color: rgba(120, 200, 150, 0.35); }
    .jobs-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 0.75rem; font-size: 0.85rem; }
    .jobs-toolbar .toggle-row { min-height: auto; }
    .empty-state { color: #9aa3b2; font-size: 0.9rem; padding: 1rem 0.5rem; line-height: 1.5; }
    .empty-state strong { color: #e6e8ec; font-weight: 600; }
    .log-placeholder { color: #9aa3b2; font-size: 0.9rem; margin: 0.5rem 0 1rem; line-height: 1.5; }
    a { color: #7eb8ff; }
    pre { background: #1a1d24; padding: 0.75rem; overflow: auto; max-height: 24rem; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; margin: 0; border-radius: 0.35rem; }
    .log-panel { margin-top: 0.35rem; }
    .log-toolbar { display: flex; align-items: center; gap: 0.75rem; margin: 0.35rem 0; font-size: 0.85rem; flex-wrap: wrap; }
    .log-toolbar label { color: #9aa3b2; cursor: pointer; user-select: none; }
    #logSteps {
      display: block;
      background: #1a1d24;
      padding: 0.75rem;
      overflow: auto;
      max-height: min(28rem, 55vh);
      font-size: 0.85rem;
      border-radius: 0.35rem;
      border: 1px solid #2a2f3a;
    }
    #logRaw { display: none; }
    body.show-raw #logSteps { display: none; }
    body.show-raw #logRaw { display: block; }
    .meta { color: #9aa3b2; font-size: 0.85rem; line-height: 1.45; }
    .token-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.75rem 0; }
    .token-row input[type=password] { flex: 1 1 12rem; min-width: 0; max-width: 24rem; padding: 0.55rem 0.65rem; font-size: 1rem; border-radius: 0.35rem; border: 1px solid #333; background: #1a1d24; color: #e6e8ec; }
    button, .btn {
      padding: 0.55rem 0.85rem;
      font-size: 0.95rem;
      border-radius: 0.35rem;
      border: 1px solid #444;
      background: #2a2f3a;
      color: #e6e8ec;
      cursor: pointer;
      min-height: 2.75rem;
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.primary { background: #3d5a8a; border-color: #5a7ab0; }
    button.danger { background: #5a3030; border-color: #884444; }
    .steer-panel { margin: 1rem 0; padding: 0.75rem; background: #141820; border: 1px solid #2a2f3a; border-radius: 0.5rem; }
    .settings-panel { margin: 1rem 0; padding: 0.75rem; background: #141820; border: 1px solid #2a2f3a; border-radius: 0.5rem; }
    .settings-panel h2 { margin: 0 0 0.35rem; font-size: 1rem; }
    .settings-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; margin-top: 0.5rem; }
    .settings-row label { font-size: 0.85rem; color: #9aa3b2; }
    .toggle-row { display: flex; align-items: center; gap: 0.45rem; min-height: 2.75rem; color: #e6e8ec; cursor: pointer; user-select: none; }
    .toggle-row input { width: 1.1rem; height: 1.1rem; }
    #notifyRecipient {
      display: block;
      width: 100%;
      min-width: 12rem;
      max-width: 24rem;
      margin-top: 0.25rem;
      padding: 0.55rem 0.65rem;
      font-size: 1rem;
      border-radius: 0.35rem;
      border: 1px solid #333;
      background: #1a1d24;
      color: #e6e8ec;
    }
    #notifyStatus { margin-top: 0.35rem; min-height: 1.2rem; }
    .steer-panel label { display: block; font-size: 0.85rem; color: #9aa3b2; margin-bottom: 0.35rem; }
    .steer-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; }
    #steerPrompt {
      flex: 1 1 100%;
      min-height: 3.5rem;
      padding: 0.55rem 0.65rem;
      font-size: 1rem;
      border-radius: 0.35rem;
      border: 1px solid #333;
      background: #1a1d24;
      color: #e6e8ec;
      resize: vertical;
      font-family: inherit;
    }
    #steerStatus { font-size: 0.85rem; color: #9aa3b2; margin-top: 0.35rem; min-height: 1.2rem; }
    .agent-turn { margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid #2a2f3a; }
    .agent-turn:last-child { border-bottom: none; margin-bottom: 0; }
    .agent-banner { font-size: 0.75rem; color: #7a8494; margin-bottom: 0.5rem; font-family: ui-monospace, monospace; }
    .agent-meta { font-size: 0.8rem; color: #9aa3b2; margin: 0.35rem 0; }
    .agent-thinking { font-size: 0.8rem; color: #8a939f; font-style: italic; margin: 0.5rem 0; line-height: 1.4; }
    .agent-thinking-label { font-style: normal; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.04em; color: #6a7380; margin-right: 0.35rem; }
    .agent-prose { line-height: 1.5; margin: 0.6rem 0; color: #e6e8ec; }
    .agent-prose p { margin: 0.35rem 0; }
    .agent-tool { margin: 0.5rem 0; padding: 0.45rem 0.55rem; background: #12151c; border-left: 3px solid #4a5568; border-radius: 0 0.25rem 0.25rem 0; }
    .agent-tool-failed { border-left-color: #c44; }
    .agent-tool-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; margin-bottom: 0.25rem; }
    .agent-tool-chip {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 0.12rem 0.4rem;
      border-radius: 0.2rem;
      background: #2d3544;
      color: #b8c4d4;
      font-family: ui-monospace, monospace;
    }
    .agent-tool-summary { font-size: 0.8rem; color: #9aa3b2; }
    .agent-tool-body {
      margin: 0.35rem 0 0;
      padding: 0.45rem 0.55rem;
      font-size: 0.78rem;
      background: #0d0f14;
      border-radius: 0.25rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      color: #c5cdd8;
    }
    .agent-tool-error { font-size: 0.8rem; color: #ff9a9a; margin-top: 0.35rem; }
    .agent-error { color: #ff9a9a; margin: 0.5rem 0; }
    .agent-plain { font-family: ui-monospace, monospace; font-size: 0.8rem; color: #b0b8c4; margin: 0.35rem 0; }
    .agent-pass-through { margin: 0; background: transparent; padding: 0; max-height: none; }
    @media (max-width: 720px) {
      body { margin: 0.75rem; }
      thead { display: none; }
      #jobs { display: block; }
      #jobs tr.job-row {
        display: block;
        border: 1px solid #333;
        border-radius: 0.5rem;
        margin-bottom: 0.65rem;
        padding: 0.5rem 0.65rem;
      }
      #jobs tr.job-row td {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        border: none;
        padding: 0.3rem 0;
        font-size: 0.9rem;
      }
      #jobs tr.job-row td::before {
        content: attr(data-label);
        color: #9aa3b2;
        font-size: 0.75rem;
        flex-shrink: 0;
      }
      #jobs tr.job-row td:first-child { font-weight: 600; }
      .steer-row button { flex: 1 1 calc(50% - 0.25rem); }
    }
  </style>
</head>
<body>
  <h1>PR Genie Local Runner</h1>
  <p class="meta">Runner dashboard · ${reachability} · <a href="/setup">Setup</a></p>
  <div class="token-row">
    <label style="flex:1 1 100%; font-size:0.85rem; color:#9aa3b2;">Bearer token
      <input type="password" id="token" placeholder="PRGENIE_RUNNER_TOKEN" autocomplete="off" />
    </label>
    <button type="button" id="saveToken">Save token</button>
  </div>
  <div class="settings-panel">
    <h2>Email notifications</h2>
    <p class="meta">Resend API key is server-side only (env). Choose whether to send job notify emails and the recipient.</p>
    <div class="settings-row">
      <label class="toggle-row"><input type="checkbox" id="notifyEnabled" /> Send notify emails</label>
      <label style="flex:1 1 14rem;">Recipient
        <input type="email" id="notifyRecipient" placeholder="you@example.com" autocomplete="email" inputmode="email" />
      </label>
      <button type="button" id="saveNotify">Save</button>
    </div>
    <div id="notifyStatus"></div>
  </div>
  <div class="settings-panel">
    <h2>New job</h2>
    <p class="meta">Start a code or docs writing job on this runner. Docs jobs use Setup defaults unless you override the repo path.</p>
    <div class="settings-row">
      <label style="flex:1 1 8rem;">Type
        <select id="newJobType" style="display:block; width:100%; margin-top:0.25rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem;">
          <option value="code">Code (default)</option>
          <option value="docs">Docs / policy / marketing</option>
        </select>
      </label>
      <label style="flex:2 1 12rem;">Branch
        <input id="newJobBranch" placeholder="docs/policy-xyz" style="display:block; width:100%; margin-top:0.25rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem;" />
      </label>
    </div>
    <div class="settings-row" id="newJobDocsRow" style="display:none;">
      <label style="flex:1 1 12rem;">Doc template
        <select id="newJobTemplate" style="display:block; width:100%; margin-top:0.25rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem;">
          <option value="marketing">Marketing copy</option>
          <option value="policy">Policy doc</option>
          <option value="research">Research brief</option>
        </select>
      </label>
    </div>
    <label>Repo path override (optional)
      <input id="newJobRepo" placeholder="Local clone path on this machine" style="display:block; width:100%; margin-top:0.25rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem;" />
    </label>
    <label id="newJobPromptLabel">Prompt file (code jobs)
      <input id="newJobPrompt" placeholder="/path/to/prompt.md" style="display:block; width:100%; margin-top:0.25rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem;" />
    </label>
    <textarea id="newJobInline" rows="3" placeholder="Optional extra task text (appended via prompt file content if you paste a one-off prompt path)" style="display:none; width:100%; margin-top:0.5rem; padding:0.55rem; background:#1a1d24; color:#e6e8ec; border:1px solid #333; border-radius:0.35rem; font-family:inherit;"></textarea>
    <button type="button" class="primary" id="startJobBtn" style="margin-top:0.75rem;">Start job</button>
    <div id="newJobStatus" class="meta" style="min-height:1.2rem; margin-top:0.35rem;"></div>
  </div>
  <div class="jobs-toolbar">
    <label class="toggle-row"><input type="checkbox" id="showAllJobs" /> Show all</label>
    <span class="meta" id="jobsHiddenHint"></span>
  </div>
  <table>
    <thead><tr><th>Job</th><th>Stage</th><th>Round</th><th>Ticket</th><th>PR</th><th>Ready</th><th>Checks</th><th>Model</th><th>Tokens</th><th>Updated</th></tr></thead>
    <tbody id="jobs"></tbody>
  </table>
  <h2 id="detailTitle">Job log</h2>
  <p class="log-placeholder" id="logPlaceholder">Select a job from the table to view its agent transcript.</p>
  <div class="steer-panel">
    <label for="steerPrompt">Steer selected job (queued for next agent step)</label>
    <div class="steer-row">
      <textarea id="steerPrompt" rows="2" placeholder="Add guidance… Enter to send, Shift+Enter for newline"></textarea>
      <button type="button" class="primary" id="steerBtn">Steer</button>
      <button type="button" class="danger" id="stopBtn">Stop</button>
    </div>
    <div id="steerStatus"></div>
  </div>
  <div class="log-toolbar">
    <label><input type="checkbox" id="showRaw" /> Raw</label>
  </div>
  <div class="log-panel">
    <div id="logSteps"></div>
    <pre id="logRaw"></pre>
  </div>
  <script>
    const logParser = ${logParserInit};
    const dashFmt = ${dashFmtInit};
    const tokenKey = "prgenie_runner_token";
    const showAllJobsKey = "prgenie_runner_show_all_jobs";
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

    const showAllJobsEl = document.getElementById("showAllJobs");
    const jobsHiddenHint = document.getElementById("jobsHiddenHint");
    showAllJobsEl.checked = localStorage.getItem(showAllJobsKey) === "1";
    showAllJobsEl.onchange = () => {
      localStorage.setItem(showAllJobsKey, showAllJobsEl.checked ? "1" : "0");
      renderJobTable(lastJobs);
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

    function fmtUpdated(iso) {
      const r = dashFmt.formatRelativeTime(iso, Date.now());
      return '<span title="' + r.title.replace(/"/g, "&quot;") + '">' + r.label + "</span>";
    }

    function statusLabel(job, ci) {
      return dashFmt.dashboardChecksStatusLabel(job, ci);
    }

    function fmtJobCell(j) {
      let line = j.id.slice(0, 8);
      if (dashFmt.isDocsJobRecord(j)) {
        const bits = [j.repoSlug || ""];
        if (j.input.docsTemplate) bits.push(j.input.docsTemplate);
        const extra = bits.filter(Boolean).join(" · ");
        if (extra) line += '<br><span class="meta">' + extra + "</span>";
      }
      return line;
    }

    function fmtChecks(job, ci) {
      if (!ci) return "—";
      const label = statusLabel(job, ci);
      const cls = "badge " + (ci.status === "success" ? "success" : ci.status || "neutral");
      const tip = ci.reason ? ' title="' + String(ci.reason).replace(/"/g, "&quot;") + '"' : "";
      const colLabel = dashFmt.isDocsJobRecord(job) ? "Doc checks" : "Status";
      if (ci.checksUrl && !dashFmt.isDocsJobRecord(job)) {
        return '<a class="' + cls + '" href="' + ci.checksUrl + '" target="_blank" rel="noopener"' + tip + ">" + label + "</a>";
      }
      return "<span class=\"" + cls + "\"" + tip + ' data-label="' + colLabel + '">' + label + "</span>";
    }

    function fmtPrDraft(j) {
      if (!j.prUrl) return "—";
      if (j.prIsDraft === true) return '<span class="badge draft">Draft</span>';
      if (j.prIsDraft === false) return '<span class="badge ready">Ready</span>';
      return "—";
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
      document.querySelector(".steer-panel").style.display = hasJob ? "block" : "none";
      document.querySelector(".log-toolbar").style.display = hasJob ? "flex" : "none";
      document.querySelector(".log-panel").style.display = hasJob ? "block" : "none";
      if (!hasJob) {
        document.getElementById("detailTitle").textContent = "Job log";
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
      const stick = stickScrollIfNearBottom(stepsEl);
      rawLogTail = raw || "";
      document.getElementById("logRaw").textContent = rawLogTail;
      const html = logParser.formatAgentLogTailHtml(rawLogTail);
      if (html) {
        stepsEl.innerHTML = html;
      } else if (rawLogTail && !logParser.looksLikeStreamJsonLog(rawLogTail)) {
        stepsEl.innerHTML = "<div class=\"agent-plain\">" + rawLogTail.replace(/</g, "&lt;") + "</div>";
      } else {
        stepsEl.innerHTML = "";
      }
      if (stick) stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    function renderJobTable(jobs) {
      const showAll = showAllJobsEl.checked;
      const hidden = showAll ? 0 : jobs.filter((j) => dashFmt.shouldHideStaleJob(j)).length;
      const visible = showAll ? jobs : jobs.filter((j) => !dashFmt.shouldHideStaleJob(j));
      jobsHiddenHint.textContent = hidden ? "(" + hidden + " hidden)" : "";
      const tbody = document.getElementById("jobs");
      if (!visible.length) {
        const msg = jobs.length
          ? "No jobs match the current filter. Turn on Show all to see hidden rows."
          : "<strong>No jobs yet.</strong> Start a job below or from MCP.";
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">' + msg + "</td></tr>";
        return;
      }
      tbody.innerHTML = visible.map(j => {
        const stageLabel = dashFmt.dashboardStageLabel(j);
        const sel = j.id === selected ? " selected" : "";
        const checksLabel = dashFmt.isDocsJobRecord(j) ? "Doc checks" : "Status";
        return \`<tr class="job-row\${sel}" data-id="\${j.id}">
        <td data-label="Job">\${fmtJobCell(j)}</td>
        <td data-label="Stage">\${stageLabel}</td>
        <td data-label="Round">\${j.reviewRound}/\${j.maxRounds}</td>
        <td data-label="Ticket">\${fmtTicket(j)}</td>
        <td data-label="PR">\${j.prUrl ? '<a href="'+j.prUrl+'" target="_blank" rel="noopener">PR</a>' : "—"}</td>
        <td data-label="Ready">\${fmtPrDraft(j)}</td>
        <td data-label="\${checksLabel}">\${fmtStatus(j, j.ciStatus)}</td>
        <td data-label="Model">\${j.model || "—"}</td>
        <td data-label="Tokens">\${fmtTokens(j.tokenUsage)}</td>
        <td data-label="Updated">\${fmtUpdated(j.updatedAt)}</td>
      </tr>\`;
      }).join("");
      tbody.querySelectorAll("tr.job-row").forEach(tr => tr.onclick = () => selectJob(tr.dataset.id));
      if (selected) {
        const row = tbody.querySelector('tr[data-id="' + selected + '"]');
        if (row) {
          selectedJobStage = jobs.find(j => j.id === selected)?.stage ?? selectedJobStage;
          row.classList.add("selected");
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
      const res = await fetch("/api/jobs", { headers: authHeaders() });
      const tbody = document.getElementById("jobs");
      if (res.status === 401) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><strong>Unauthorized.</strong> Paste your runner bearer token above and click Save token.</td></tr>';
        lastJobs = [];
        return;
      }
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Could not reach the runner (' + res.status + "). Check that serve is running.</td></tr>";
        lastJobs = [];
        return;
      }
      lastJobs = await res.json();
      renderJobTable(lastJobs);
    }

    function selectJob(id) {
      selected = id;
      steerStatus.textContent = "";
      document.getElementById("detailTitle").textContent = "Job " + id.slice(0, 8);
      updateDetailVisibility();
      document.querySelectorAll("tr.job-row").forEach(tr => {
        tr.classList.toggle("selected", tr.dataset.id === id);
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
        renderLogTail(j.logTail || "");
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
