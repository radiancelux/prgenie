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
  <div class="panel">
    <h2 style="margin-top:0;">Docs mode</h2>
    <p class="meta">Target repos for Markdown PRs (marketing, policy, research). Example preset label: <code>cc-consulting-nv/img-business</code> — add your own path or GitHub slug; nothing is baked into the runner binary.</p>
    <p class="meta">Private org repos may need <code>gh auth</code> on this host (and optional Cursor GitHub App access). Prefer an existing local clone path for v1.</p>
    <p class="meta">Research jobs: enable web search in <code>~/.cursor/cli-config.json</code> (<code>autoAcceptWebSearch</code>, <code>permissions.allow</code> for WebFetch). Headless runs use <code>--force --trust</code> — see <a href="https://cursor.com/docs/cli/using" target="_blank" rel="noopener">Cursor CLI docs</a>.</p>
    <div id="repoPresets"></div>
    <button type="button" id="addPreset" style="width:auto; margin-top:0.5rem;">Add repo preset</button>
    <label>Default repo for code jobs
      <select id="defaultCodePreset"></select>
    </label>
    <label>Default repo for docs jobs
      <select id="defaultDocsPreset"></select>
    </label>
    <label class="toggle-row"><input type="checkbox" id="docChecksEnabled" checked /> Run doc checks (markdown lint on changed .md)</label>
    <label class="toggle-row"><input type="checkbox" id="docChecksFailHard" /> Fail hard on doc check errors (blocks ready-to-publish)</label>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">MCP / shared runner</h2>
    <p class="meta">Bearer token is per runner install. MCP <code>start_job</code> on Brett's runner uses his workstation, Cursor CLI login, and <code>gh</code> identity. Do not paste tokens into tickets or job logs.</p>
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

    function renderRepoPresets(presets) {
      const el = document.getElementById("repoPresets");
      el.innerHTML = (presets || []).map((p) => \`
        <div class="driver-card" data-preset-id="\${p.id}">
          <label>Name<input class="preset-name" value="\${p.name || ""}" /></label>
          <label>GitHub slug (owner/repo)<input class="preset-slug" placeholder="org/repo" value="\${p.slug || ""}" /></label>
          <label>Local path on runner<input class="preset-path" placeholder="/path/to/clone" value="\${p.repoPath || ""}" /></label>
          <button type="button" class="remove-preset" style="width:auto; margin-top:0.35rem; background:#5a3030;">Remove</button>
        </div>\`).join("");
      el.querySelectorAll(".remove-preset").forEach((btn) => {
        btn.onclick = () => btn.closest(".driver-card")?.remove();
      });
    }

    function fillPresetSelects(presets, selectedCode, selectedDocs) {
      const opts = ['<option value="">— none —</option>'].concat(
        (presets || []).map((p) => \`<option value="\${p.id}">\${p.name}</option>\`),
      );
      const codeSel = document.getElementById("defaultCodePreset");
      const docsSel = document.getElementById("defaultDocsPreset");
      codeSel.innerHTML = opts.join("");
      docsSel.innerHTML = opts.join("");
      codeSel.value = selectedCode || "";
      docsSel.value = selectedDocs || "";
    }

    document.getElementById("addPreset").onclick = () => {
      const id = "preset-" + Math.random().toString(36).slice(2, 9);
      const presets = collectPresetsFromDom();
      presets.push({ id, name: "New repo", slug: "", repoPath: "" });
      renderRepoPresets(presets);
      fillPresetSelects(presets, document.getElementById("defaultCodePreset").value, document.getElementById("defaultDocsPreset").value);
    };

    function collectPresetsFromDom() {
      return [...document.querySelectorAll("#repoPresets .driver-card")].map((card) => ({
        id: card.dataset.presetId,
        name: card.querySelector(".preset-name").value.trim() || "Repo",
        slug: card.querySelector(".preset-slug").value.trim() || null,
        repoPath: card.querySelector(".preset-path").value.trim() || null,
      }));
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
      const ds = loaded.docsSettings || {};
      renderRepoPresets(ds.repoPresets || []);
      fillPresetSelects(ds.repoPresets || [], ds.defaultPresetId?.code, ds.defaultPresetId?.docs);
      document.getElementById("docChecksEnabled").checked = ds.docChecks?.enabled !== false;
      document.getElementById("docChecksFailHard").checked = Boolean(ds.docChecks?.failHard);
      if (loaded.envDefaultCodeRepoPath) {
        document.getElementById("dataDirNote").textContent += " · Env code repo: " + loaded.envDefaultCodeRepoPath;
      }
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
      const repoPresets = collectPresetsFromDom();
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
        presets: { repos: repoPresets },
        jobTypes: {
          defaultPresetId: {
            code: document.getElementById("defaultCodePreset").value || null,
            docs: document.getElementById("defaultDocsPreset").value || null,
          },
          docChecks: {
            enabled: document.getElementById("docChecksEnabled").checked,
            failHard: document.getElementById("docChecksFailHard").checked,
          },
        },
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
        renderRepoPresets(loaded.docsSettings?.repoPresets || []);
        fillPresetSelects(
          loaded.docsSettings?.repoPresets || [],
          loaded.docsSettings?.defaultPresetId?.code,
          loaded.docsSettings?.defaultPresetId?.docs,
        );
      } catch {
        status.textContent = "Save failed (network).";
      }
    };

    void load();
  </script>
</body>
</html>`;
}
