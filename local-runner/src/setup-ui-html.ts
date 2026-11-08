import { COMPUTE_JOB_DEFAULT_WATCHDOG } from "./job-type-watchdog.js";
import { runnerListenUrls } from "./listen-urls.js";
import { dashboardStylesheet } from "./dashboard-styles.js";
import {
  MAX_ACTIVE_JOBS_MAX,
  MAX_ACTIVE_JOBS_MIN,
  MAX_ROUNDS_MAX,
  MAX_ROUNDS_MIN,
  WATCHDOG_INACTIVITY_MS_MAX,
  WATCHDOG_INACTIVITY_MS_MIN,
  WATCHDOG_RECOVERY_ATTEMPTS_MAX,
  WATCHDOG_RECOVERY_ATTEMPTS_MIN,
  WATCHDOG_STAGE_CAP_MS_MAX,
  WATCHDOG_STAGE_CAP_MS_MIN,
} from "./runner-policy.js";

const SETUP_VALIDATION_BOUNDS = {
  maxRounds: { min: MAX_ROUNDS_MIN, max: MAX_ROUNDS_MAX },
  maxActiveJobs: { min: MAX_ACTIVE_JOBS_MIN, max: MAX_ACTIVE_JOBS_MAX },
  watchdog: {
    inactivityMs: { min: WATCHDOG_INACTIVITY_MS_MIN, max: WATCHDOG_INACTIVITY_MS_MAX },
    stageCapMs: { min: WATCHDOG_STAGE_CAP_MS_MIN, max: WATCHDOG_STAGE_CAP_MS_MAX },
    recoveryAttempts: { min: WATCHDOG_RECOVERY_ATTEMPTS_MIN, max: WATCHDOG_RECOVERY_ATTEMPTS_MAX },
  },
  computeWatchdogDefaults: COMPUTE_JOB_DEFAULT_WATCHDOG,
};

export function setupUiHtml(
  port: number,
  listenUrls: string[] = [`http://127.0.0.1:${port}/`],
  tokenFilePath = "~/.prgenie/local-runner/runner.token",
): string {
  const reachability = listenUrls.length ? listenUrls.join(" · ") : `http://127.0.0.1:${port}/`;
  const boundsJson = JSON.stringify(SETUP_VALIDATION_BOUNDS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Runner Setup · PR Genie</title>
  ${dashboardStylesheet()}
</head>
<body class="min-h-screen overflow-x-hidden bg-zinc-950 text-zinc-100 antialiased">
  <main class="mx-auto max-w-lg overflow-x-hidden px-4 py-6">
  <p class="nav mb-3 text-sm"><a class="text-sky-400 hover:underline" href="/">← Dashboard</a></p>
  <h1 class="text-xl font-semibold">Runner setup</h1>
  <p class="meta text-sm text-zinc-400">${reachability}</p>
  <div class="panel mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
    <label class="block min-w-0">Bearer token (stored in this browser only)
      <input type="password" id="token" class="min-w-0 max-w-full" placeholder="PRGENIE_RUNNER_TOKEN" autocomplete="off" />
    </label>
    <p class="meta">Host token file: <code>${tokenFilePath}</code></p>
  </div>
  <div id="authHint" class="panel empty-cta" style="display:none;" role="status"></div>
  <div id="firstRun" class="panel empty-cta" style="display:none;">
    <strong>First run.</strong> Choose a default agent driver and model, optional email notify, then save. Runner token stays in env — do not paste it into job logs.
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Defaults</h2>
    <label class="block min-w-0">Default model
      <input id="defaultModel" class="min-w-0 max-w-full" placeholder="composer-2.5" />
    </label>
    <label class="block min-w-0">Default driver
      <select id="defaultDriver" class="min-w-0 max-w-full"></select>
    </label>
    <label class="block min-w-0">Host / LAN bind hint (display)
      <input id="hostBindHint" class="min-w-0 max-w-full" placeholder="0.0.0.0:9473 on LAN" />
    </label>
    <p class="meta">Data dir path is shown after load (server-side).</p>
    <p class="meta" id="dataDirNote"></p>
  </div>
  <div class="panel" id="runnerPolicyPanel">
    <h2 style="margin-top:0;">Runner policy</h2>
    <p class="meta">Defaults for new jobs and concurrency. Bounds match <code>PATCH /api/settings</code> and the MCP <code>settings</code> tool.</p>
    <label class="block min-w-0">Default max rounds (per job)
      <input type="number" id="defaultMaxRounds" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-defaultMaxRounds" hidden></p>
    <p class="meta" id="defaultMaxRoundsMeta"></p>
    <label class="block min-w-0">Max concurrent active jobs
      <input type="number" id="maxActiveJobs" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-maxActiveJobs" hidden></p>
    <h3 class="mt-3 text-sm font-medium">Per-stage default models</h3>
    <p class="meta">Leave blank to inherit. Fix defaults to <code>auto</code> on drivers that support it.</p>
    <label class="block min-w-0">Build model
      <input id="stageModelBuild" class="min-w-0 max-w-full" placeholder="inherits default model" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-stageModelBuild" hidden></p>
    <label class="block min-w-0">Review model
      <input id="stageModelReview" class="min-w-0 max-w-full" placeholder="inherits build / default" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-stageModelReview" hidden></p>
    <label class="block min-w-0">Fix model
      <input id="stageModelFix" class="min-w-0 max-w-full" placeholder="auto" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-stageModelFix" hidden></p>
    <p class="meta" id="stageModelsEffective"></p>
    <h3 class="mt-3 text-sm font-medium">Watchdog (code / docs jobs)</h3>
    <label class="block min-w-0">Inactivity limit (ms)
      <input type="number" id="watchdogInactivityMs" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-watchdogInactivityMs" hidden></p>
    <label class="block min-w-0">Stage time cap (ms)
      <input type="number" id="watchdogStageCapMs" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-watchdogStageCapMs" hidden></p>
    <label class="block min-w-0">Recovery attempts
      <input type="number" id="watchdogRecoveryAttempts" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-watchdogRecoveryAttempts" hidden></p>
    <h3 class="mt-3 text-sm font-medium">Watchdog (compute jobs)</h3>
    <p class="meta">Longer built-ins unless overridden here (<code>jobTypes.compute.watchdog</code>).</p>
    <label class="block min-w-0">Inactivity limit (ms)
      <input type="number" id="computeWatchdogInactivityMs" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-computeWatchdogInactivityMs" hidden></p>
    <label class="block min-w-0">Stage time cap (ms)
      <input type="number" id="computeWatchdogStageCapMs" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-computeWatchdogStageCapMs" hidden></p>
    <label class="block min-w-0">Recovery attempts
      <input type="number" id="computeWatchdogRecoveryAttempts" class="min-w-0 max-w-full" inputmode="numeric" />
    </label>
    <p class="meta field-error text-sm text-red-400" id="err-computeWatchdogRecoveryAttempts" hidden></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Email notify</h2>
    <label class="toggle-row"><input type="checkbox" id="notifyEnabled" /> Send notify emails</label>
    <label class="block min-w-0">Recipient
      <input type="email" id="notifyRecipient" class="min-w-0 max-w-full" autocomplete="email" />
    </label>
    <p class="meta" id="notifyMeta"></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Drivers</h2>
    <div id="drivers"></div>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">Docs mode</h2>
    <p class="meta">Target repos for Markdown PRs (marketing, policy, research). Example preset label: <code>your-org/your-docs-repo</code> — add your own path or GitHub slug; nothing is baked into the runner binary.</p>
    <p class="meta">Private org repos may need <code>gh auth</code> on this host (and optional Cursor GitHub App access). Prefer an existing local clone path for v1.</p>
    <p class="meta">Research jobs: enable web search in <code>~/.cursor/cli-config.json</code> (<code>autoAcceptWebSearch</code>, <code>permissions.allow</code> for WebFetch). Headless runs use <code>--force --trust</code> — see <a href="https://cursor.com/docs/cli/using" target="_blank" rel="noopener">Cursor CLI docs</a>.</p>
    <div id="repoPresets"></div>
    <button type="button" id="addPreset" style="width:auto; margin-top:0.5rem;">Add repo preset</button>
    <label class="block min-w-0">Default repo for code jobs
      <select id="defaultCodePreset" class="min-w-0 max-w-full"></select>
    </label>
    <label class="block min-w-0">Default repo for docs jobs
      <select id="defaultDocsPreset" class="min-w-0 max-w-full"></select>
    </label>
    <label class="toggle-row"><input type="checkbox" id="docChecksEnabled" checked /> Run doc checks (markdown lint on changed .md)</label>
    <label class="toggle-row"><input type="checkbox" id="docChecksFailHard" /> Fail hard on doc check errors (blocks ready-to-publish)</label>
  </div>
  <div class="panel">
    <h2 style="margin-top:0;">MCP / shared runner</h2>
    <p class="meta">Bearer token is per runner install. MCP <code>start_job</code> on the host runner uses the runner host's workstation, Cursor CLI login, and <code>gh</code> identity. Do not paste tokens into tickets or job logs.</p>
  </div>
  <button type="button" id="save" class="mt-4 min-h-11 w-full rounded-md border border-sky-700 bg-sky-900/50 px-4 py-2 font-medium text-sky-100">Save settings</button>
  <div id="status" class="mt-2 min-h-5 text-sm text-zinc-400" role="status"></div>
  </main>
  <script>
    const BOUNDS = ${boundsJson};
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

    function clearFieldErrors() {
      for (const el of document.querySelectorAll(".field-error")) {
        el.hidden = true;
        el.textContent = "";
      }
    }

    function showFieldError(id, message) {
      const el = document.getElementById("err-" + id);
      if (!el) return;
      el.textContent = message;
      el.hidden = !message;
    }

    function validateBoundedInt(raw, label, min, max) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return label + " must be a finite number";
      const v = Math.trunc(n);
      if (v < min || v > max) return label + " must be between " + min + " and " + max;
      return null;
    }

    function validatePolicyForm() {
      const errors = {};
      const mr = validateBoundedInt(
        document.getElementById("defaultMaxRounds").value,
        "maxRounds",
        BOUNDS.maxRounds.min,
        BOUNDS.maxRounds.max,
      );
      if (mr) errors.defaultMaxRounds = mr;
      const ma = validateBoundedInt(
        document.getElementById("maxActiveJobs").value,
        "maxActiveJobs",
        BOUNDS.maxActiveJobs.min,
        BOUNDS.maxActiveJobs.max,
      );
      if (ma) errors.maxActiveJobs = ma;
      for (const key of ["build", "review", "fix"]) {
        const id = "stageModel" + key.charAt(0).toUpperCase() + key.slice(1);
        const v = document.getElementById(id).value.trim();
        if (v && typeof v !== "string") errors[id] = "stageModels." + key + " must be a string";
      }
      const wd = BOUNDS.watchdog;
      const w1 = validateBoundedInt(
        document.getElementById("watchdogInactivityMs").value,
        "watchdog.inactivityMs",
        wd.inactivityMs.min,
        wd.inactivityMs.max,
      );
      if (w1) errors.watchdogInactivityMs = w1;
      const w2 = validateBoundedInt(
        document.getElementById("watchdogStageCapMs").value,
        "watchdog.stageCapMs",
        wd.stageCapMs.min,
        wd.stageCapMs.max,
      );
      if (w2) errors.watchdogStageCapMs = w2;
      const w3 = validateBoundedInt(
        document.getElementById("watchdogRecoveryAttempts").value,
        "watchdog.recoveryAttempts",
        wd.recoveryAttempts.min,
        wd.recoveryAttempts.max,
      );
      if (w3) errors.watchdogRecoveryAttempts = w3;
      const c1 = validateBoundedInt(
        document.getElementById("computeWatchdogInactivityMs").value,
        "watchdog.inactivityMs",
        wd.inactivityMs.min,
        wd.inactivityMs.max,
      );
      if (c1) errors.computeWatchdogInactivityMs = c1;
      const c2 = validateBoundedInt(
        document.getElementById("computeWatchdogStageCapMs").value,
        "watchdog.stageCapMs",
        wd.stageCapMs.min,
        wd.stageCapMs.max,
      );
      if (c2) errors.computeWatchdogStageCapMs = c2;
      const c3 = validateBoundedInt(
        document.getElementById("computeWatchdogRecoveryAttempts").value,
        "watchdog.recoveryAttempts",
        wd.recoveryAttempts.min,
        wd.recoveryAttempts.max,
      );
      if (c3) errors.computeWatchdogRecoveryAttempts = c3;
      return errors;
    }

    function resolveEffectiveComputeWatchdog(settings) {
      const base = BOUNDS.computeWatchdogDefaults;
      const o = settings?.jobTypes?.compute?.watchdog || {};
      return {
        inactivityMs: o.inactivityMs ?? base.inactivityMs,
        stageCapMs: o.stageCapMs ?? base.stageCapMs,
        recoveryAttempts: o.recoveryAttempts ?? base.recoveryAttempts,
      };
    }

    function updateEffectiveLabels() {
      if (!loaded) return;
      const envModel = loaded.envDefaultModel || "";
      const defaultModel =
        document.getElementById("defaultModel").value.trim() ||
        loaded.defaultModel ||
        envModel;
      const sm = loaded.stageModels || {};
      const buildStored = document.getElementById("stageModelBuild").value.trim();
      const reviewStored = document.getElementById("stageModelReview").value.trim();
      const fixStored = document.getElementById("stageModelFix").value.trim();
      const build = buildStored || sm.build || defaultModel;
      const review = reviewStored || sm.review || sm.build || defaultModel;
      const fix =
        fixStored ||
        sm.fix ||
        loaded.envDefaultFixModel ||
        "auto";
      document.getElementById("stageModelsEffective").textContent =
        "Effective: build " +
        build +
        " · review " +
        review +
        " · fix " +
        fix +
        (loaded.defaultModel ? "" : " (default model from env: " + envModel + ")");
      const effRounds = loaded.defaultMaxRounds ?? loaded.effectiveDefaultMaxRounds;
      document.getElementById("defaultMaxRoundsMeta").textContent =
        "Stored default max rounds: " +
        effRounds +
        (loaded.envDefaultModel ? " · env model " + loaded.envDefaultModel : "");
    }

    function renderDrivers(drivers) {
      const el = document.getElementById("drivers");
      el.innerHTML = drivers.map((d) => \`
        <div class="driver-card" data-id="\${d.id}">
          <strong>\${d.id}</strong> · \${d.kind}
          <label>Binary<input class="drv-binary min-w-0 max-w-full" value="\${d.binary || ""}" /></label>
          <label>Endpoint<input class="drv-endpoint min-w-0 max-w-full" value="\${d.endpoint || ""}" /></label>
          <label>API key (optional)<input class="drv-key min-w-0 max-w-full" type="password" placeholder="\${d.hasApiKey ? d.apiKeyMasked || "••••" : "paste to set"}" autocomplete="off" /></label>
        </div>\`).join("");
    }

    function renderRepoPresets(presets) {
      const el = document.getElementById("repoPresets");
      el.innerHTML = (presets || []).map((p) => \`
        <div class="driver-card" data-preset-id="\${p.id}">
          <label>Name<input class="preset-name min-w-0 max-w-full" value="\${p.name || ""}" /></label>
          <label>GitHub slug (owner/repo)<input class="preset-slug min-w-0 max-w-full" placeholder="org/repo" value="\${p.slug || ""}" /></label>
          <label>Local path on runner<input class="preset-path min-w-0 max-w-full" placeholder="/path/to/clone" value="\${p.repoPath || ""}" /></label>
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

    function stageInputValue(id, stored) {
      return stored == null ? "" : String(stored);
    }

    function applyPolicyFromLoaded() {
      document.getElementById("defaultMaxRounds").value = String(
        loaded.defaultMaxRounds ?? loaded.effectiveDefaultMaxRounds ?? BOUNDS.maxRounds.min,
      );
      document.getElementById("maxActiveJobs").value = String(loaded.maxActiveJobs ?? BOUNDS.maxActiveJobs.min);
      const sm = loaded.stageModels || {};
      document.getElementById("stageModelBuild").value = stageInputValue(null, sm.build);
      document.getElementById("stageModelReview").value = stageInputValue(null, sm.review);
      document.getElementById("stageModelFix").value = stageInputValue(null, sm.fix);
      const w = loaded.watchdog || {};
      document.getElementById("watchdogInactivityMs").value = String(w.inactivityMs ?? "");
      document.getElementById("watchdogStageCapMs").value = String(w.stageCapMs ?? "");
      document.getElementById("watchdogRecoveryAttempts").value = String(w.recoveryAttempts ?? "");
      const cw = resolveEffectiveComputeWatchdog(loaded);
      document.getElementById("computeWatchdogInactivityMs").value = String(cw.inactivityMs);
      document.getElementById("computeWatchdogStageCapMs").value = String(cw.stageCapMs);
      document.getElementById("computeWatchdogRecoveryAttempts").value = String(cw.recoveryAttempts);
      updateEffectiveLabels();
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

    for (const id of [
      "defaultModel",
      "stageModelBuild",
      "stageModelReview",
      "stageModelFix",
    ]) {
      document.getElementById(id).addEventListener("input", () => updateEffectiveLabels());
    }

    const tokenFileHint = ${JSON.stringify(tokenFilePath)};

    async function load() {
      const status = document.getElementById("status");
      const authHint = document.getElementById("authHint");
      const res = await fetch("/api/settings", { headers: authHeaders() });
      if (res.status === 401) {
        const t = tokenEl.value || localStorage.getItem(tokenKey);
        authHint.style.display = "block";
        if (t) {
          authHint.innerHTML = "<strong>Token rejected.</strong> Check <code>" + tokenFileHint + "</code> or PRGENIE_RUNNER_TOKEN.";
        } else {
          authHint.innerHTML = "<strong>Unauthorized.</strong> Paste the bearer token from <code>" + tokenFileHint + "</code> above, then Save settings.";
        }
        status.textContent = "";
        return;
      }
      authHint.style.display = "none";
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
      applyPolicyFromLoaded();
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
      clearFieldErrors();
      const errors = validatePolicyForm();
      for (const [field, message] of Object.entries(errors)) {
        showFieldError(field, message);
      }
      if (Object.keys(errors).length) {
        status.textContent = "Fix validation errors above.";
        return;
      }
      status.textContent = "Saving…";
      const drivers = [...document.querySelectorAll("#drivers .driver-card")].map((card) => {
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
      const stageVal = (elId) => {
        const v = document.getElementById(elId).value.trim();
        return v ? v : null;
      };
      const body = {
        configured: true,
        defaultModel: document.getElementById("defaultModel").value.trim() || null,
        defaultDriver: document.getElementById("defaultDriver").value,
        hostBindHint: document.getElementById("hostBindHint").value.trim() || null,
        defaultMaxRounds: Math.trunc(Number(document.getElementById("defaultMaxRounds").value)),
        maxActiveJobs: Math.trunc(Number(document.getElementById("maxActiveJobs").value)),
        stageModels: {
          build: stageVal("stageModelBuild"),
          review: stageVal("stageModelReview"),
          fix: stageVal("stageModelFix"),
        },
        watchdog: {
          inactivityMs: Math.trunc(Number(document.getElementById("watchdogInactivityMs").value)),
          stageCapMs: Math.trunc(Number(document.getElementById("watchdogStageCapMs").value)),
          recoveryAttempts: Math.trunc(Number(document.getElementById("watchdogRecoveryAttempts").value)),
        },
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
          compute: {
            watchdog: {
              inactivityMs: Math.trunc(Number(document.getElementById("computeWatchdogInactivityMs").value)),
              stageCapMs: Math.trunc(Number(document.getElementById("computeWatchdogStageCapMs").value)),
              recoveryAttempts: Math.trunc(
                Number(document.getElementById("computeWatchdogRecoveryAttempts").value),
              ),
            },
          },
        },
      };
      try {
        const res = await fetch("/api/settings", { method: "PATCH", headers: authHeaders(true), body: JSON.stringify(body) });
        if (res.status === 400) {
          const err = await res.json().catch(() => ({}));
          const message = err.error || "Validation failed";
          status.textContent = message;
          if (message.includes("maxRounds")) showFieldError("defaultMaxRounds", message);
          else if (message.includes("maxActiveJobs")) showFieldError("maxActiveJobs", message);
          else if (message.includes("watchdog.inactivityMs")) {
            showFieldError(
              message.includes("compute") ? "computeWatchdogInactivityMs" : "watchdogInactivityMs",
              message,
            );
          } else if (message.includes("stageCapMs")) {
            showFieldError(
              message.includes("compute") ? "computeWatchdogStageCapMs" : "watchdogStageCapMs",
              message,
            );
          } else if (message.includes("recoveryAttempts")) {
            showFieldError(
              message.includes("compute") ? "computeWatchdogRecoveryAttempts" : "watchdogRecoveryAttempts",
              message,
            );
          }
          return;
        }
        if (!res.ok) {
          status.textContent = "Save failed (" + res.status + ").";
          return;
        }
        loaded = await res.json();
        status.textContent = "Saved.";
        document.getElementById("firstRun").style.display = "none";
        renderDrivers(loaded.drivers);
        applyPolicyFromLoaded();
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
