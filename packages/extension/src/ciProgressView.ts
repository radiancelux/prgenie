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
  slotQueueLine?: string;
  rows: CiCardCheckRow[];
};

const TERMINAL_STATES = new Set(["pass", "fail", "skip", "skipped", "cached", "cancelled"]);

/** Map runner progress states to sidebar labels. */
export function normalizeCiDisplayState(state: string | undefined, cancelled?: boolean): string {
  if (cancelled && (!state || state === "start" || state === "queued")) return "cancelled";
  if (!state || state === "queued") return "queued";
  if (state === "start") return "running";
  return state;
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

function mergeStoredRow(row: CiCardCheckInput): CiCardCheckRow {
  const state = row.skipped
    ? "skipped"
    : row.passed === true
      ? "pass"
      : row.passed === false
        ? "fail"
        : normalizeCiDisplayState(row.state);
  return {
    name: row.name,
    displayName: shortCheckName(row.name),
    state,
    elapsedMs: row.elapsedMs,
    message: row.message,
    logPath: row.logPath,
    command: row.command,
    reason: row.reason,
  };
}

function mergeLiveRow(row: CiCardCheckInput, cancelled?: boolean): CiCardCheckRow {
  const state = normalizeCiDisplayState(
    row.state,
    cancelled && row.state !== "pass" && row.state !== "fail",
  );
  return {
    name: row.name,
    displayName: shortCheckName(row.name),
    state,
    elapsedMs: row.elapsedMs,
    message: row.message,
    logPath: row.logPath,
    command: row.command,
    reason: row.reason,
  };
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

export function formatCiProgressSummaryLine(
  done: number,
  total: number,
  overallElapsedMs: number,
): string {
  if (total <= 0) return "";
  const count = `${done} of ${total} check${total === 1 ? "" : "s"} done`;
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
  const summary = model.summaryLine.replace(/^/, "");
  if (summary) {
    return `Open on GitHub unavailable — ${step} (${summary})`;
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
  const names =
    (live.length ? live.map((c) => c.name) : undefined) ??
    input.plan?.checks ??
    input.stored?.map((c) => c.name) ??
    [];
  const hasLiveCi =
    progress &&
    (progress.phase === "ci" ||
      progress.state === "start" ||
      (progress.checks && progress.checks.length > 0));
  if (!names.length && !reason && !cwdLine && !hasLiveCi) {
    return { show: false, reason: "", cwd: "", summaryLine: "", rows: [] };
  }
  const byName = new Map<string, CiCardCheckRow>();
  for (const row of live) {
    byName.set(row.name, mergeLiveRow(row, progress?.cancelled));
  }
  for (const row of input.stored ?? []) {
    if (!byName.has(row.name)) byName.set(row.name, mergeStoredRow(row));
  }
  const rows: CiCardCheckRow[] = (names.length ? names : ["(waiting)"]).map((name) => {
    const existing = byName.get(name);
    if (existing) return existing;
    return {
      name,
      displayName: shortCheckName(name),
      state: progress && !progress.cancelled ? "queued" : "unknown",
    };
  });
  const timing = summarizeCiRun(rows, {
    nowMs,
    startedAtMs: progress?.startedAtMs,
  });
  const summaryLine = formatCiProgressSummaryLine(
    timing.done,
    timing.total,
    timing.overallElapsedMs,
  );
  return {
    show: true,
    reason: reason || "CI checks",
    cwd: cwdLine,
    summaryLine,
    slotQueueLine: timing.slotWait,
    rows,
  };
}

/** Self-contained render for webview injection (no module imports in the browser). */
export const RENDER_CI_CARD_BODY = `
  function normalizeCiDisplayState(state, cancelled) {
    if (cancelled && (!state || state === "start" || state === "queued")) return "cancelled";
    if (!state || state === "queued") return "queued";
    if (state === "start") return "running";
    return state;
  }
  function isCiCheckDone(state) {
    return state === "pass" || state === "fail" || state === "skip" || state === "skipped" || state === "cached" || state === "cancelled";
  }
  function formatCiProgressSummaryLine(done, total, overallElapsedMs) {
    if (total <= 0) return "";
    var count = done + " of " + total + " check" + (total === 1 ? "" : "s") + " done";
    var elapsed = overallElapsedMs > 0 ? " · " + formatElapsed(overallElapsedMs) : "";
    return count + elapsed;
  }
  function parseHeavySlotWaitMessage(message) {
    if (!message) return undefined;
    var trimmed = String(message).trim();
    if (!/heavy-test slot/i.test(trimmed)) return undefined;
    return trimmed;
  }
  function buildCiCardModel(progress, plan, stored, storedCwd, nowMs) {
    nowMs = nowMs != null ? nowMs : Date.now();
    var planReason = plan && plan.reason ? (Array.isArray(plan.reason) ? plan.reason.join("; ") : plan.reason) : "";
    var reason = ((progress && progress.selectionReason) || planReason || "").trim();
    var cwdLine = ((progress && progress.cwd) || storedCwd || "").trim();
    var live = (progress && progress.checks) || [];
    var names = (live.length ? live.map(function (c) { return c.name; }) : null)
      || (plan && plan.checks)
      || (stored && stored.map(function (c) { return c.name; }))
      || [];
    var hasLiveCi = progress && (progress.phase === "ci" || progress.state === "start" || (progress.checks && progress.checks.length));
    if (!names.length && !reason && !cwdLine && !hasLiveCi) {
      return { show: false, reason: "", cwd: "", summaryLine: "", rows: [] };
    }
    var byName = {};
    for (var i = 0; i < live.length; i++) {
      var row = live[i];
      var st = normalizeCiDisplayState(row.state, progress && progress.cancelled && row.state !== "pass" && row.state !== "fail");
      byName[row.name] = {
        name: row.name,
        displayName: row.name === "format:check" ? "format" : row.name,
        state: st,
        elapsedMs: row.elapsedMs,
        message: row.message,
        logPath: row.logPath,
        command: row.command,
        reason: row.reason,
      };
    }
    for (var j = 0; j < (stored || []).length; j++) {
      var srow = stored[j];
      if (byName[srow.name]) continue;
      var sst = srow.skipped ? "skipped" : (srow.passed ? "pass" : (srow.passed === false ? "fail" : normalizeCiDisplayState(srow.state)));
      byName[srow.name] = {
        name: srow.name,
        displayName: srow.name === "format:check" ? "format" : srow.name,
        state: sst,
        elapsedMs: srow.elapsedMs,
        message: srow.message,
        logPath: srow.logPath,
        command: srow.command,
        reason: srow.reason,
      };
    }
    var rows = (names.length ? names : ["(waiting)"]).map(function (name) {
      if (byName[name]) return byName[name];
      return {
        name: name,
        displayName: name === "format:check" ? "format" : name,
        state: progress && !progress.cancelled ? "queued" : "unknown",
      };
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
    var summaryLine = formatCiProgressSummaryLine(done, rows.length, wall);
    return { show: true, reason: reason || "CI checks", cwd: cwdLine, summaryLine: summaryLine, slotQueueLine: slotWait, rows: rows };
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
    var html = '<div class="ci-card-why">' + escapeHtml(model.reason) + "</div>";
    if (model.cwd) {
      html += '<div class="ci-card-cwd muted">Cwd: ' + escapeHtml(model.cwd) + "</div>";
    }
    if (model.summaryLine) {
      html += '<div class="ci-card-summary">' + escapeHtml(model.summaryLine) + "</div>";
    }
    if (model.slotQueueLine) {
      html += '<div class="ci-card-slot muted">' + escapeHtml(model.slotQueueLine) + "</div>";
    }
    html += "<ul class='ci-checks'>";
    for (var i = 0; i < model.rows.length; i++) {
      var row = model.rows[i];
      var elapsed = row.elapsedMs != null ? " · " + formatElapsed(row.elapsedMs) : "";
      var logHint = row.logPath ? " · log" : "";
      html += '<li><button type="button" class="ci-check ' + escapeHtml(row.state) + '" data-check="' + escapeHtml(row.name) + '" data-state="' + escapeHtml(row.state) + '" data-excerpt="' + escapeHtml(row.message || "") + '" data-log="' + escapeHtml(row.logPath || "") + '" data-elapsed="' + (row.elapsedMs != null ? row.elapsedMs : "") + '" data-reason="' + escapeHtml(row.reason || model.reason || "") + '" data-command="' + escapeHtml(row.command || "") + '"><span class="st">' + escapeHtml(row.state) + '</span><span class="name">' + escapeHtml(row.displayName) + "</span><span class='muted'>" + elapsed + logHint + "</span></button></li>";
    }
    html += "</ul>";
    host.innerHTML = html;
    for (var bi = 0; bi < host.querySelectorAll(".ci-check[data-check]").length; bi++) {
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
      })(host.querySelectorAll(".ci-check[data-check]")[bi]);
    }
  }
  function formatExportGateBusyReason(input) {
    var nowMs = input.nowMs != null ? input.nowMs : Date.now();
    var model = buildCiCardModel(input.progress, input.plan, input.stored, undefined, nowMs);
    var step = (input.step && String(input.step).trim()) || "export in progress";
    if (!model.show || model.rows.length === 0) {
      return "Open on GitHub unavailable — " + step;
    }
    var summary = model.summaryLine || "";
    if (summary) {
      return "Open on GitHub unavailable — " + step + " (" + summary + ")";
    }
    return "Open on GitHub unavailable — " + step;
  }
`;
