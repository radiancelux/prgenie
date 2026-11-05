import { streamJsonLogBrowserScript } from "./stream-json-log.js";

export function runnerUiHtml(port: number): string {
  const logParserInit = streamJsonLogBrowserScript();
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
    .badge { font-size: 0.75rem; padding: 0.15rem 0.4rem; border-radius: 0.25rem; background: #2a2f3a; display: inline-block; }
    .badge.success { color: #6fdc8c; }
    .badge.failure { color: #ff8a8a; }
    .badge.pending { color: #c9b458; }
    .badge.neutral { color: #9aa3b2; }
    .badge.merged { color: #9ad0ff; }
    .badge.merge_conflict { color: #ffb86c; }
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
  <p class="meta">Port ${port} — agent transcript from stream-json (SSE). Batch G: <code>cursor-agent --force --trust</code>.</p>
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
  <table>
    <thead><tr><th>Job</th><th>Stage</th><th>Round</th><th>Ticket</th><th>PR</th><th>Status</th><th>Model</th><th>Tokens</th><th>Updated</th></tr></thead>
    <tbody id="jobs"></tbody>
  </table>
  <h2 id="detailTitle">Log tail</h2>
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
    <label><input type="checkbox" id="showRaw" /> Show raw log (debug)</label>
  </div>
  <div class="log-panel">
    <div id="logSteps"></div>
    <pre id="logRaw"></pre>
  </div>
  <script>
    const logParser = ${logParserInit};
    const tokenKey = "prgenie_runner_token";
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

    function updateSteerUi() {
      const disabled = !selected || TERMINAL_STAGES.has(selectedJobStage || "");
      steerEl.disabled = disabled;
      steerBtn.disabled = disabled;
      stopBtn.disabled = !selected || TERMINAL_STAGES.has(selectedJobStage || "");
    }

    function fmtTokens(u) {
      if (!u) return "—";
      const total = u.total ?? (u.input + u.output + (u.cacheRead||0) + (u.cacheWrite||0));
      if (!total) return "—";
      const compact = total >= 1000 ? (Math.round(total/100)/10) + "k" : String(total);
      const detail = "in " + (u.input||0) + ", out " + (u.output||0);
      return '<span title="' + detail + '">' + compact + "</span>";
    }
    function fmtStatus(ci) {
      if (!ci) return "—";
      const label = ci.summary || ci.status;
      const cls = "badge " + (ci.status || "neutral");
      if (ci.checksUrl) return '<a class="' + cls + '" href="' + ci.checksUrl + '" target="_blank" rel="noopener">' + label + "</a>";
      return '<span class="' + cls + '">' + label + "</span>";
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
      stepsEl.innerHTML = html || (rawLogTail ? logParser.formatAgentLogTail(rawLogTail).replace(/</g, "&lt;") : "");
      if (stick) stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    async function refresh() {
      const res = await fetch("/api/jobs", { headers: authHeaders() });
      if (!res.ok) { document.getElementById("jobs").innerHTML = "<tr><td colspan=9>Unauthorized or error</td></tr>"; return; }
      const jobs = await res.json();
      const tbody = document.getElementById("jobs");
      tbody.innerHTML = jobs.map(j => {
        const stageLabel = j.stage + (j.stage==="reviewing" ? " (r"+j.reviewRound+")" : "");
        const sel = j.id === selected ? " selected" : "";
        return \`<tr class="job-row\${sel}" data-id="\${j.id}">
        <td data-label="Job">\${j.id.slice(0,8)}</td>
        <td data-label="Stage">\${stageLabel}</td>
        <td data-label="Round">\${j.reviewRound}/\${j.maxRounds}</td>
        <td data-label="Ticket">\${fmtTicket(j)}</td>
        <td data-label="PR">\${j.prUrl ? '<a href="'+j.prUrl+'" target="_blank" rel="noopener">PR</a>' : "—"}</td>
        <td data-label="Status">\${fmtStatus(j.ciStatus)}</td>
        <td data-label="Model">\${j.model || "—"}</td>
        <td data-label="Tokens">\${fmtTokens(j.tokenUsage)}</td>
        <td data-label="Updated">\${j.updatedAt}</td>
      </tr>\`;
      }).join("");
      tbody.querySelectorAll("tr.job-row").forEach(tr => tr.onclick = () => selectJob(tr.dataset.id));
      if (selected) {
        const row = tbody.querySelector('tr[data-id="' + selected + '"]');
        if (row) {
          selectedJobStage = jobs.find(j => j.id === selected)?.stage ?? selectedJobStage;
          row.classList.add("selected");
        }
      }
      updateSteerUi();
      if (!selected && jobs[0]) selectJob(jobs[0].id);
    }

    function selectJob(id) {
      selected = id;
      steerStatus.textContent = "";
      document.getElementById("detailTitle").textContent = "Job " + id;
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

    updateSteerUi();
    refresh();
    void loadNotifySettingsUi();
    setInterval(refresh, 8000);
  </script>
</body>
</html>`;
}
