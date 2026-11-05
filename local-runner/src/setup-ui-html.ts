import { runnerListenUrls } from "./listen-urls.js";

export function setupUiHtml(
  port: number,
  listenUrls: string[] = [`http://127.0.0.1:${port}/`],
): string {
  const reachability = listenUrls.length ? listenUrls.join(" · ") : `http://127.0.0.1:${port}/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Runner Setup · PR Genie</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 1rem 1.25rem 2rem; background: #0f1115; color: #e6e8ec; max-width: 28rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.35rem; }
    h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; font-weight: 600; }
    .meta { color: #9aa3b2; font-size: 0.85rem; line-height: 1.45; }
    a { color: #7eb8ff; }
    .panel { margin: 1rem 0; padding: 0.75rem; background: #141820; border: 1px solid #2a2f3a; border-radius: 0.5rem; }
    label { display: block; font-size: 0.85rem; color: #9aa3b2; margin-top: 0.5rem; }
    input, select, textarea {
      width: 100%; margin-top: 0.25rem; padding: 0.55rem 0.65rem; font-size: 1rem;
      border-radius: 0.35rem; border: 1px solid #333; background: #1a1d24; color: #e6e8ec;
    }
    .toggle-row { display: flex; align-items: center; gap: 0.45rem; min-height: 2.75rem; color: #e6e8ec; cursor: pointer; }
    .toggle-row input { width: 1.1rem; height: 1.1rem; margin: 0; }
    button { margin-top: 0.75rem; padding: 0.55rem 0.85rem; font-size: 0.95rem; border-radius: 0.35rem; border: 1px solid #444; background: #3d5a8a; color: #e6e8ec; cursor: pointer; min-height: 2.75rem; width: 100%; }
    .empty-cta { padding: 1rem 0; line-height: 1.55; }
    .empty-cta strong { color: #e6e8ec; }
    #status { min-height: 1.25rem; margin-top: 0.5rem; font-size: 0.85rem; color: #9aa3b2; }
    .driver-card { border: 1px solid #2a2f3a; border-radius: 0.35rem; padding: 0.5rem; margin-top: 0.5rem; font-size: 0.85rem; }
    .nav { margin: 0.5rem 0 1rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <p class="nav"><a href="/">← Dashboard</a></p>
  <h1>Runner setup</h1>
  <p class="meta">${reachability}</p>
  <div class="panel">
    <label>Bearer token (stored in this browser only)
      <input type="password" id="token" placeholder="PRGENIE_RUNNER_TOKEN" autocomplete="off" />
    </label>
  </div>
  <div id="firstRun" class="panel empty-cta" style="display:none;">
    <strong>First run.</strong> Choose a default agent driver and model, optional email notify, then save. Runner token stays in env — do not paste it into job logs.
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Defaults</h2>
    <label>Default model
      <input id="defaultModel" placeholder="composer-2.5" />
    </label>
    <label>Default driver
      <select id="defaultDriver"></select>
    </label>
    <label>Host / LAN bind hint (display)
      <input id="hostBindHint" placeholder="0.0.0.0:9473 on LAN" />
    </label>
    <p class="meta">Data dir path is shown after load (server-side).</p>
    <p class="meta" id="dataDirNote"></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Email notify</h2>
    <label class="toggle-row"><input type="checkbox" id="notifyEnabled" /> Send notify emails</label>
    <label>Recipient
      <input type="email" id="notifyRecipient" autocomplete="email" />
    </label>
    <p class="meta" id="notifyMeta"></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Drivers</h2>
    <div id="drivers"></div>
  </div>
  <button type="button" id="save">Save settings</button>
  <div id="status"></div>
  <script>
    const tokenKey = "prgenie_runner_token";
    const tokenEl = document.getElementById("token");
    tokenEl.value = localStorage.getItem(tokenKey) || "";
    tokenEl.onchange = () => localStorage.setItem(tokenKey, tokenEl.value);

    function authHeaders(json) {
      const t = tokenEl.value || localStorage.getItem(tokenKey);
      const h = t ? { Authorization: "Bearer " + t } : {};
      if (json) h["Content-Type"] = "application/json";
      return h;
    }

    let loaded = null;

    function renderDrivers(drivers) {
      const el = document.getElementById("drivers");
      el.innerHTML = drivers.map((d) => \`
        <div class="driver-card" data-id="\${d.id}">
          <strong>\${d.id}</strong> · \${d.kind}
          <label>Binary<input class="drv-binary" value="\${d.binary || ""}" /></label>
          <label>Endpoint<input class="drv-endpoint" value="\${d.endpoint || ""}" /></label>
          <label>API key (optional)<input class="drv-key" type="password" placeholder="\${d.hasApiKey ? d.apiKeyMasked || "••••" : "paste to set"}" autocomplete="off" /></label>
        </div>\`).join("");
    }

    async function load() {
      const status = document.getElementById("status");
      const res = await fetch("/api/settings", { headers: authHeaders() });
      if (res.status === 401) {
        status.textContent = "Save bearer token above (from PRGENIE_RUNNER_TOKEN).";
        return;
      }
      if (!res.ok) {
        status.textContent = "Could not load settings.";
        return;
      }
      loaded = await res.json();
      document.getElementById("firstRun").style.display = loaded.configured ? "none" : "block";
      document.getElementById("defaultModel").value = loaded.defaultModel || loaded.envDefaultModel || "";
      document.getElementById("hostBindHint").value = loaded.hostBindHint || "";
      document.getElementById("dataDirNote").textContent = "Data dir: " + loaded.dataDirNote;
      document.getElementById("notifyEnabled").checked = Boolean(loaded.notify?.enabled);
      document.getElementById("notifyRecipient").value = loaded.notify?.recipient || "";
      const nm = [];
      if (loaded.envFallbackRecipient) nm.push("Env fallback: " + loaded.envFallbackRecipient);
      if (!loaded.resendConfigured) nm.push("Resend not configured on server.");
      document.getElementById("notifyMeta").textContent = nm.join(" · ");
      const sel = document.getElementById("defaultDriver");
      sel.innerHTML = loaded.drivers.map((d) =>
        \`<option value="\${d.id}">\${d.id}</option>\`).join("");
      sel.value = loaded.defaultDriver || "cursor-agent";
      renderDrivers(loaded.drivers);
    }

    document.getElementById("save").onclick = async () => {
      const status = document.getElementById("status");
      status.textContent = "Saving…";
      const drivers = [...document.querySelectorAll(".driver-card")].map((card) => {
        const id = card.dataset.id;
        const keyEl = card.querySelector(".drv-key");
        const keyVal = keyEl.value.trim();
        const entry = {
          id,
          kind: loaded.drivers.find((d) => d.id === id)?.kind || "custom",
          binary: card.querySelector(".drv-binary").value.trim() || null,
          endpoint: card.querySelector(".drv-endpoint").value.trim() || null,
        };
        if (keyVal) entry.apiKey = keyVal;
        return entry;
      });
      const body = {
        configured: true,
        defaultModel: document.getElementById("defaultModel").value.trim() || null,
        defaultDriver: document.getElementById("defaultDriver").value,
        hostBindHint: document.getElementById("hostBindHint").value.trim() || null,
        notify: {
          enabled: document.getElementById("notifyEnabled").checked,
          recipient: document.getElementById("notifyRecipient").value.trim() || null,
        },
        drivers,
      };
      try {
        const res = await fetch("/api/settings", { method: "PATCH", headers: authHeaders(true), body: JSON.stringify(body) });
        if (!res.ok) {
          status.textContent = "Save failed (" + res.status + ").";
          return;
        }
        loaded = await res.json();
        status.textContent = "Saved.";
        document.getElementById("firstRun").style.display = "none";
        renderDrivers(loaded.drivers);
      } catch {
        status.textContent = "Save failed (network).";
      }
    };

    void load();
  </script>
</body>
</html>`;
}
