import { formatElapsed, shortCheckName } from "@prgenie/core";

export type CiCardCheckInput = {
  name: string;
  state?: string;
  elapsedMs?: number;
  command?: string;
  message?: string;
  logPath?: string;
  reason?: string;
  skipped?: boolean;
  passed?: boolean;
};

export type CiCardBuildInput = {
  progress: {
    phase?: string;
    state?: string;
    cancelled?: boolean;
    checks?: CiCardCheckInput[];
    selectionReason?: string;
    cwd?: string;
    startedAtMs?: number;
  } | null;
  plan: { checks: string[]; reason?: string | string[] } | null;
  stored: CiCardCheckInput[] | null;
  storedCwd?: string | null;
  nowMs?: number;
};

export type CiCardCheckRow = {
  name: string;
  displayName: string;
  state: string;
  /** Original runner value when `state` is "unknown" (shown as a tooltip). */
  rawState?: string;
  elapsedMs?: number;
  message?: string;
  logPath?: string;
  command?: string;
  reason?: string;
};

export type CiCardModel = {
  show: boolean;
  reason: string;
  cwd: string;
  summaryLine: string;
  /** "N of M checks done" only — the polite live region text (no ticking elapsed). */
  countLine: string;
  elapsedLabel: string;
  slotQueueLine?: string;
  rows: CiCardCheckRow[];
};

/** Runner / snapshot / persisted-gate state values → sidebar display state. */
export const CI_KNOWN_STATES: Readonly<Record<string, string>> = {
  queued: "queued",
  pending: "pending",
  start: "running",
  started: "running",
  running: "running",
  in_progress: "running",
  waiting: "waiting",
  pass: "pass",
  passed: "pass",
  success: "pass",
  fail: "fail",
  failed: "fail",
  failure: "fail",
  error: "fail",
  skip: "skipped",
  skipped: "skipped",
  cancelled: "cancelled",
  canceled: "cancelled",
  cached: "cached",
};

const TERMINAL_STATES = new Set(["pass", "fail", "skipped", "cached", "cancelled"]);

export type CiDisplayState = { state: string; rawState?: string };

/** Map a runner state to a known display state; unrecognized values become "unknown". */
export function resolveCiDisplayState(
  state: string | undefined,
  cancelled?: boolean,
): CiDisplayState {
  const raw = (state ?? "").trim();
  const key = raw.toLowerCase();
  const known = key
    ? Object.prototype.hasOwnProperty.call(CI_KNOWN_STATES, key)
      ? CI_KNOWN_STATES[key]
      : undefined
    : "queued";
  if (cancelled && (known === "queued" || known === "pending" || known === "running")) {
    return { state: "cancelled" };
  }
  if (known) return { state: known };
  return { state: "unknown", rawState: raw };
}

export function normalizeCiDisplayState(state: string | undefined, cancelled?: boolean): string {
  return resolveCiDisplayState(state, cancelled).state;
}

/** Tooltip for a check's state pill; unknown states keep the raw runner value visible. */
export function ciStateTitle(row: Pick<CiCardCheckRow, "state" | "rawState">): string {
  if (row.state === "unknown") {
    return row.rawState ? `Unknown runner state: ${row.rawState}` : "Unknown runner state";
  }
  return row.state;
}

export function isCiCheckDone(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function parseHeavySlotWaitMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!/heavy-test slot/i.test(trimmed)) return undefined;
  return trimmed;
}

export function planSelectionReason(plan: CiCardBuildInput["plan"]): string {
  if (!plan?.reason) return "";
  return Array.isArray(plan.reason) ? plan.reason.join("; ") : plan.reason;
}

function toRow(row: CiCardCheckInput, resolved: CiDisplayState): CiCardCheckRow {
  return {
    name: row.name,
    displayName: shortCheckName(row.name),
    state: resolved.state,
    ...(resolved.rawState !== undefined ? { rawState: resolved.rawState } : {}),
    elapsedMs: row.elapsedMs,
    message: row.message,
    logPath: row.logPath,
    command: row.command,
    reason: row.reason,
  };
}

function mergeStoredRow(row: CiCardCheckInput): CiCardCheckRow {
  const resolved: CiDisplayState = row.skipped
    ? { state: "skipped" }
    : row.passed === true
      ? { state: "pass" }
      : row.passed === false
        ? { state: "fail" }
        : resolveCiDisplayState(row.state);
  return toRow(row, resolved);
}

function mergeLiveRow(row: CiCardCheckInput, cancelled?: boolean): CiCardCheckRow {
  return toRow(row, resolveCiDisplayState(row.state, cancelled));
}

/** Plan order first, then any reported checks the plan did not list. */
function orderedCheckNames(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const name of list ?? []) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function summarizeCiRun(
  rows: CiCardCheckRow[],
  options: { nowMs: number; startedAtMs?: number },
): { done: number; total: number; overallElapsedMs: number; slotWait?: string } {
  const total = rows.length;
  let done = 0;
  let sumElapsed = 0;
  let slotWait: string | undefined;
  for (const row of rows) {
    if (isCiCheckDone(row.state)) done += 1;
    if (row.elapsedMs != null) sumElapsed += row.elapsedMs;
    if (row.state === "waiting") {
      slotWait = parseHeavySlotWaitMessage(row.message) ?? row.message;
    }
  }
  const wall =
    options.startedAtMs != null && options.startedAtMs > 0
      ? Math.max(0, options.nowMs - options.startedAtMs)
      : sumElapsed;
  return { done, total, overallElapsedMs: wall, slotWait };
}

export function formatCiProgressCountLine(done: number, total: number): string {
  if (total <= 0) return "";
  return `${done} of ${total} check${total === 1 ? "" : "s"} done`;
}

export function formatCiProgressSummaryLine(
  done: number,
  total: number,
  overallElapsedMs: number,
): string {
  const count = formatCiProgressCountLine(done, total);
  if (!count) return "";
  const elapsed = overallElapsedMs > 0 ? ` · ${formatElapsed(overallElapsedMs)}` : "";
  return count + elapsed;
}

export function formatExportGateBusyReason(input: {
  step?: string;
  progress: CiCardBuildInput["progress"];
  plan: CiCardBuildInput["plan"];
  stored: CiCardBuildInput["stored"];
  nowMs?: number;
}): string {
  const model = buildCiCardModel({
    progress: input.progress,
    plan: input.plan,
    stored: input.stored,
    nowMs: input.nowMs,
  });
  const step = (input.step && input.step.trim()) || "export in progress";
  if (!model.show || model.rows.length === 0) {
    return `Open on GitHub unavailable — ${step}`;
  }
  if (model.summaryLine) {
    return `Open on GitHub unavailable — ${step} (${model.summaryLine})`;
  }
  return `Open on GitHub unavailable — ${step}`;
}

export function buildCiCardModel(input: CiCardBuildInput): CiCardModel {
  const nowMs = input.nowMs ?? Date.now();
  const progress = input.progress;
  const planReason = planSelectionReason(input.plan);
  const reason = (progress?.selectionReason || planReason || "").trim();
  const cwdLine = (progress?.cwd || input.storedCwd || "").trim();
  const live = progress?.checks ?? [];
  // Persisted results belong to the previous gate run; during a live run an
  // unreported planned check is queued, not last run's pass/fail.
  const stored = progress ? [] : (input.stored ?? []);
  const names = orderedCheckNames(
    input.plan?.checks,
    live.map((c) => c.name),
    stored.map((c) => c.name),
  );
  const hasLiveCi =
    progress &&
    (progress.phase === "ci" ||
      progress.state === "start" ||
      (progress.checks && progress.checks.length > 0));
  if (!names.length && !reason && !cwdLine && !hasLiveCi) {
    return {
      show: false,
      reason: "",
      cwd: "",
      summaryLine: "",
      countLine: "",
      elapsedLabel: "",
      rows: [],
    };
  }
  const byName = new Map<string, CiCardCheckRow>();
  for (const row of live) {
    byName.set(row.name, mergeLiveRow(row, progress?.cancelled));
  }
  for (const row of stored) {
    if (!byName.has(row.name)) byName.set(row.name, mergeStoredRow(row));
  }
  const unreported = progress ? (progress.cancelled ? "cancelled" : "queued") : "pending";
  const rows: CiCardCheckRow[] = (names.length ? names : ["(waiting)"]).map((name) => {
    const existing = byName.get(name);
    if (existing) return existing;
    return { name, displayName: shortCheckName(name), state: unreported };
  });
  const timing = summarizeCiRun(rows, {
    nowMs,
    startedAtMs: progress?.startedAtMs,
  });
  return {
    show: true,
    reason: reason || "CI checks",
    cwd: cwdLine,
    summaryLine: formatCiProgressSummaryLine(timing.done, timing.total, timing.overallElapsedMs),
    countLine: formatCiProgressCountLine(timing.done, timing.total),
    elapsedLabel: timing.overallElapsedMs > 0 ? formatElapsed(timing.overallElapsedMs) : "",
    slotQueueLine: timing.slotWait,
    rows,
  };
}

/**
 * Persistent CI card skeleton. The count span is the polite live region and is
 * only rewritten when its text changes, so ticking elapsed time is not announced.
 */
export const CI_CARD_SHELL_HTML =
  '<div class="ci-card-head"></div>' +
  '<div class="ci-card-summary">' +
  '<span class="ci-card-count" role="status" aria-live="polite" aria-atomic="true"></span>' +
  '<span class="ci-card-elapsed muted"></span>' +
  "</div>" +
  '<div class="ci-card-rest"></div>';

/** Self-contained render for webview injection (no module imports in the browser). */
export const RENDER_CI_CARD_BODY = `
  var CI_KNOWN_STATES = ${JSON.stringify(CI_KNOWN_STATES)};
  var CI_CARD_SHELL_HTML = ${JSON.stringify(CI_CARD_SHELL_HTML)};
  function resolveCiDisplayState(state, cancelled) {
    var raw = String(state == null ? "" : state).trim();
    var key = raw.toLowerCase();
    var known = key ? (Object.prototype.hasOwnProperty.call(CI_KNOWN_STATES, key) ? CI_KNOWN_STATES[key] : undefined) : "queued";
    if (cancelled && (known === "queued" || known === "pending" || known === "running")) {
      return { state: "cancelled" };
    }
    if (known) return { state: known };
    return { state: "unknown", rawState: raw };
  }
  function normalizeCiDisplayState(state, cancelled) {
    return resolveCiDisplayState(state, cancelled).state;
  }
  function ciStateTitle(row) {
    if (row.state === "unknown") {
      return row.rawState ? "Unknown runner state: " + row.rawState : "Unknown runner state";
    }
    return row.state;
  }
  function isCiCheckDone(state) {
    return state === "pass" || state === "fail" || state === "skipped" || state === "cached" || state === "cancelled";
  }
  function formatCiProgressCountLine(done, total) {
    if (total <= 0) return "";
    return done + " of " + total + " check" + (total === 1 ? "" : "s") + " done";
  }
  function formatCiProgressSummaryLine(done, total, overallElapsedMs) {
    var count = formatCiProgressCountLine(done, total);
    if (!count) return "";
    var elapsed = overallElapsedMs > 0 ? " · " + formatElapsed(overallElapsedMs) : "";
    return count + elapsed;
  }
  function parseHeavySlotWaitMessage(message) {
    if (!message) return undefined;
    var trimmed = String(message).trim();
    if (!/heavy-test slot/i.test(trimmed)) return undefined;
    return trimmed;
  }
  function ciCheckRow(row, resolved) {
    var out = {
      name: row.name,
      displayName: row.name === "format:check" ? "format" : row.name,
      state: resolved.state,
      elapsedMs: row.elapsedMs,
      message: row.message,
      logPath: row.logPath,
      command: row.command,
      reason: row.reason,
    };
    if (resolved.rawState !== undefined) out.rawState = resolved.rawState;
    return out;
  }
  function buildCiCardModel(progress, plan, stored, storedCwd, nowMs) {
    nowMs = nowMs != null ? nowMs : Date.now();
    var planReason = plan && plan.reason ? (Array.isArray(plan.reason) ? plan.reason.join("; ") : plan.reason) : "";
    var reason = ((progress && progress.selectionReason) || planReason || "").trim();
    var cwdLine = ((progress && progress.cwd) || storedCwd || "").trim();
    var live = (progress && progress.checks) || [];
    var past = progress ? [] : (stored || []);
    var names = [];
    var seen = {};
    var lists = [(plan && plan.checks) || [], live.map(function (c) { return c.name; }), past.map(function (c) { return c.name; })];
    for (var li = 0; li < lists.length; li++) {
      for (var ni = 0; ni < lists[li].length; ni++) {
        var nm = lists[li][ni];
        if (!nm || seen[nm]) continue;
        seen[nm] = true;
        names.push(nm);
      }
    }
    var hasLiveCi = progress && (progress.phase === "ci" || progress.state === "start" || (progress.checks && progress.checks.length));
    if (!names.length && !reason && !cwdLine && !hasLiveCi) {
      return { show: false, reason: "", cwd: "", summaryLine: "", countLine: "", elapsedLabel: "", rows: [] };
    }
    var byName = {};
    for (var i = 0; i < live.length; i++) {
      byName[live[i].name] = ciCheckRow(live[i], resolveCiDisplayState(live[i].state, progress && progress.cancelled));
    }
    for (var j = 0; j < past.length; j++) {
      var srow = past[j];
      if (byName[srow.name]) continue;
      var resolved = srow.skipped ? { state: "skipped" } : (srow.passed === true ? { state: "pass" } : (srow.passed === false ? { state: "fail" } : resolveCiDisplayState(srow.state)));
      byName[srow.name] = ciCheckRow(srow, resolved);
    }
    var unreported = progress ? (progress.cancelled ? "cancelled" : "queued") : "pending";
    var rows = (names.length ? names : ["(waiting)"]).map(function (name) {
      if (byName[name]) return byName[name];
      return { name: name, displayName: name === "format:check" ? "format" : name, state: unreported };
    });
    var done = 0;
    var sumElapsed = 0;
    var slotWait;
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      if (isCiCheckDone(r.state)) done += 1;
      if (r.elapsedMs != null) sumElapsed += r.elapsedMs;
      if (r.state === "waiting") slotWait = parseHeavySlotWaitMessage(r.message) || r.message;
    }
    var wall = progress && progress.startedAtMs ? Math.max(0, nowMs - progress.startedAtMs) : sumElapsed;
    return {
      show: true,
      reason: reason || "CI checks",
      cwd: cwdLine,
      summaryLine: formatCiProgressSummaryLine(done, rows.length, wall),
      countLine: formatCiProgressCountLine(done, rows.length),
      elapsedLabel: wall > 0 ? formatElapsed(wall) : "",
      slotQueueLine: slotWait,
      rows: rows,
    };
  }
  function renderCiCard(host, progress, plan, stored, storedCwd) {
    if (!host) return;
    var model = buildCiCardModel(progress, plan, stored, storedCwd, Date.now());
    if (!model.show) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    if (!host.querySelector(".ci-card-count[role='status']")) host.innerHTML = CI_CARD_SHELL_HTML;
    var head = '<div class="ci-card-why">' + escapeHtml(model.reason) + "</div>";
    if (model.cwd) {
      head += '<div class="ci-card-cwd muted">Cwd: ' + escapeHtml(model.cwd) + "</div>";
    }
    host.querySelector(".ci-card-head").innerHTML = head;
    var count = host.querySelector(".ci-card-count");
    if (count.textContent !== model.countLine) count.textContent = model.countLine;
    host.querySelector(".ci-card-elapsed").textContent = model.elapsedLabel ? " · " + model.elapsedLabel : "";
    var html = "";
    if (model.slotQueueLine) {
      html += '<div class="ci-card-slot muted">' + escapeHtml(model.slotQueueLine) + "</div>";
    }
    html += "<ul class='ci-checks'>";
    for (var i = 0; i < model.rows.length; i++) {
      var row = model.rows[i];
      var elapsed = row.elapsedMs != null ? " · " + formatElapsed(row.elapsedMs) : "";
      var logHint = row.logPath ? " · log" : "";
      html += '<li><button type="button" class="ci-check ' + escapeHtml(row.state) + '" data-check="' + escapeHtml(row.name) + '" data-state="' + escapeHtml(row.state) + '" data-excerpt="' + escapeHtml(row.message || "") + '" data-log="' + escapeHtml(row.logPath || "") + '" data-elapsed="' + (row.elapsedMs != null ? row.elapsedMs : "") + '" data-reason="' + escapeHtml(row.reason || model.reason || "") + '" data-command="' + escapeHtml(row.command || "") + '"><span class="st" title="' + escapeHtml(ciStateTitle(row)) + '">' + escapeHtml(row.state) + '</span><span class="name">' + escapeHtml(row.displayName) + "</span><span class='muted'>" + elapsed + logHint + "</span></button></li>";
    }
    html += "</ul>";
    var rest = host.querySelector(".ci-card-rest");
    rest.innerHTML = html;
    var buttons = rest.querySelectorAll(".ci-check[data-check]");
    for (var bi = 0; bi < buttons.length; bi++) {
      (function (btn) {
        btn.onclick = function () {
          vscode.postMessage({
            type: "openCiDetail",
            check: btn.getAttribute("data-check"),
            state: btn.getAttribute("data-state"),
            excerpt: btn.getAttribute("data-excerpt"),
            logPath: btn.getAttribute("data-log") || undefined,
            command: btn.getAttribute("data-command") || undefined,
            elapsedMs: btn.getAttribute("data-elapsed") ? Number(btn.getAttribute("data-elapsed")) : undefined,
            reason: btn.getAttribute("data-reason") || undefined,
          });
        };
      })(buttons[bi]);
    }
  }
  function formatExportGateBusyReason(input) {
    var nowMs = input.nowMs != null ? input.nowMs : Date.now();
    var model = buildCiCardModel(input.progress, input.plan, input.stored, undefined, nowMs);
    var step = (input.step && String(input.step).trim()) || "export in progress";
    if (!model.show || model.rows.length === 0) {
      return "Open on GitHub unavailable — " + step;
    }
    if (model.summaryLine) {
      return "Open on GitHub unavailable — " + step + " (" + model.summaryLine + ")";
    }
    return "Open on GitHub unavailable — " + step;
  }
`;
