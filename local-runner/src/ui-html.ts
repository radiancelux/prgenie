export function runnerUiHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PR Genie Local Runner</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #0f1115; color: #e6e8ec; }
    h1 { font-size: 1.25rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #333; font-size: 0.85rem; }
    .badge { font-size: 0.75rem; padding: 0.1rem 0.35rem; border-radius: 0.25rem; background: #2a2f3a; }
    .badge.success { color: #6fdc8c; }
    .badge.failure { color: #ff8a8a; }
    .badge.pending { color: #c9b458; }
    .badge.neutral { color: #9aa3b2; }
    a { color: #7eb8ff; }
    pre { background: #1a1d24; padding: 0.75rem; overflow: auto; max-height: 20rem; font-size: 0.8rem; }
    .meta { color: #9aa3b2; font-size: 0.85rem; }
    input[type=password] { width: 20rem; padding: 0.35rem; }
  </style>
</head>
<body>
  <h1>PR Genie Local Runner</h1>
  <p class="meta">localhost:${port} — log stream uses SSE (stream-json lines when agents run). Batch G: <code>cursor-agent --force --trust</code> required; plain text output is end-only.</p>
  <p><label>Bearer token <input type="password" id="token" placeholder="PRGENIE_RUNNER_TOKEN" /></label>
  <button id="saveToken">Save</button></p>
  <table>
    <thead><tr><th>Job</th><th>Stage</th><th>Round</th><th>Ticket</th><th>PR</th><th>Model</th><th>Tokens</th><th>CI</th><th>Updated</th></tr></thead>
    <tbody id="jobs"></tbody>
  </table>
  <h2 id="detailTitle">Log tail</h2>
  <pre id="log"></pre>
  <script>
    const tokenKey = "prgenie_runner_token";
    const tokenEl = document.getElementById("token");
    tokenEl.value = localStorage.getItem(tokenKey) || "";
    document.getElementById("saveToken").onclick = () => {
      localStorage.setItem(tokenKey, tokenEl.value);
      refresh();
    };
    function authHeaders() {
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      return t ? { Authorization: "Bearer " + t } : {};
    }
    let selected = null;
    let es = null;
    function fmtTokens(u) {
      if (!u) return "—";
      const total = u.total ?? (u.input + u.output + (u.cacheRead||0) + (u.cacheWrite||0));
      if (!total) return "—";
      const compact = total >= 1000 ? (Math.round(total/100)/10) + "k" : String(total);
      const detail = "in " + (u.input||0) + ", out " + (u.output||0);
      return '<span title="' + detail + '">' + compact + "</span>";
    }
    function fmtCi(ci) {
      if (!ci) return "—";
      const label = ci.status + (ci.source ? " (" + ci.source + ")" : "");
      const cls = "badge " + (ci.status || "neutral");
      if (ci.checksUrl) return '<a class="' + cls + '" href="' + ci.checksUrl + '" target="_blank">' + label + "</a>";
      return '<span class="' + cls + '">' + label + "</span>";
    }
    function fmtTicket(j) {
      if (j.ticketUrl && j.linearIssue) return '<a href="' + j.ticketUrl + '" target="_blank">' + j.linearIssue + "</a>";
      if (j.ticketUrl) return '<a href="' + j.ticketUrl + '" target="_blank">ticket</a>';
      return "—";
    }
    async function refresh() {
      const res = await fetch("/api/jobs", { headers: authHeaders() });
      if (!res.ok) { document.getElementById("jobs").innerHTML = "<tr><td colspan=9>Unauthorized or error</td></tr>"; return; }
      const jobs = await res.json();
      const tbody = document.getElementById("jobs");
      tbody.innerHTML = jobs.map(j => \`<tr data-id="\${j.id}" style="cursor:pointer">
        <td>\${j.id.slice(0,8)}</td>
        <td>\${j.stage}\${j.stage==="reviewing"?" (r"+j.reviewRound+")":""}</td>
        <td>\${j.reviewRound}/\${j.maxRounds}</td>
        <td>\${fmtTicket(j)}</td>
        <td>\${j.prUrl ? '<a href="'+j.prUrl+'" target="_blank">PR</a>' : "—"}</td>
        <td>\${j.model || "—"}</td>
        <td>\${fmtTokens(j.tokenUsage)}</td>
        <td>\${fmtCi(j.ciStatus)}</td>
        <td>\${j.updatedAt}</td>
      </tr>\`).join("");
      tbody.querySelectorAll("tr").forEach(tr => tr.onclick = () => selectJob(tr.dataset.id));
      if (!selected && jobs[0]) selectJob(jobs[0].id);
    }
    function selectJob(id) {
      selected = id;
      document.getElementById("detailTitle").textContent = "Job " + id;
      if (es) es.close();
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      es = new EventSource("/api/jobs/" + id + "/stream?token=" + encodeURIComponent(t || ""));
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.logTail !== undefined) document.getElementById("log").textContent = data.logTail;
        if (data.stage) refresh();
      };
      fetch("/api/jobs/" + id, { headers: authHeaders() }).then(r => r.json()).then(j => {
        document.getElementById("log").textContent = j.logTail || "";
      });
    }
    refresh();
    setInterval(refresh, 8000);
  </script>
</body>
</html>`;
}
