import { readFileSync } from "node:fs";
import path from "node:path";
import {
  addLocalPrComment,
  addressLocalPrComment,
  archiveLoopsMergedOnGithub,
  attachLocalPr,
  bindRepoGithub,
  claimReview,
  completeLocalPrReview,
  createLocalPr,
  deleteLocalPr,
  deleteLocalPrComment,
  editLocalPrComment,
  exportLocalPr,
  ensureWorktreeForLoop,
  findGitRoot,
  findLocalPrForCurrentWorktree,
  formatClaimReview,
  formatDoctorReport,
  formatExportPartialFailure,
  getLocalPr,
  getLocalPrDiff,
  getLocalPrNameStatus,
  refreshLocalPrHead,
  getRepoGithubBind,
  describeRepoGithubBind,
  requireGithubBindForReviewed,
  getRepoWatch,
  formatWatchLane,
  formatWatchStatus,
  LISTEN_REMOVED_MESSAGE,
  listGhAccounts,
  listLocalPrs,
  listSessions,
  formatSessionEvent,
  isArchivedPr,
  listWorktrees,
  pendingReviewComments,
  reopenLocalPr,
  resolveLocalPrComment,
  runDoctor,
  setLocalPrStatus,
  markReviewInterrupted,
  resumeReview,
  formatSessionReconnectDigest,
  reconcileOneLoop,
  updateLocalPr,
  createProgressCardSink,
  evaluateAndStoreExportGate,
  formatProgressLine,
  humanExportUi,
  runLoopCi,
  isAbortError,
  bindSteward,
  formatStewardBinding,
  formatStewardDecision,
  listStewardBindings,
  stewardNext,
  type CommentRole,
  type LocalPr,
  type LocalPrStatus,
} from "@prgenie/core";

function usage(): string {
  return `PR Genie — local pull requests for agent work. GitHub when you say so.

Usage:
  prgenie version
  prgenie create [--title <t>] [--body <b>] [--base <ref>] [--head <ref>]
  prgenie attach <pr-url|pr-number|branch> [--title <t>] [--body <b>] [--base <ref>]
  prgenie list [--all] [--search <q>] [--query <q>] [--in title,body,comment,file]
  prgenie queue
  prgenie inbox
  prgenie watch
  prgenie claim-review <id> [--head <sha>] [--source <name>]
  prgenie steward
  prgenie steward <id> [--restart] [--implementor-missing] [--implementor-failed] [--json]
  prgenie steward bind <id> [--implementor <taskId>] [--reviewer <taskId>]
  prgenie doctor
  prgenie sessions [--limit N] [--hook <name>] [--since <iso>] [--json]
  prgenie export <id> [--skip-validation] [--verbose]
  prgenie show <id>
  prgenie shepherd <id> [--verbose]
  prgenie ci <id> [--failing <checks>] [--no-fail-fast] [--no-parallel] [--skip-cache]
  prgenie update <id> [--title <t>] [--body <summary>]
  prgenie diff <id> [--stat] [-- <path>...]
  prgenie delete <id> [--yes]
  prgenie reopen <id>
  prgenie approve <id>
  prgenie ready <id> [--ci-skip <reason>]
  prgenie review-interrupted <id> [--reason <text>]
  prgenie review-resume <id>
  prgenie reconcile [id]
  prgenie request-changes <id> [-m <message>]
  prgenie comment <id> -m <message> [--role human|agent|reviewer] [--author <name>] [--path <file>] [--line <n>] [--side left|right] [--reply-to <commentId>] [--body-file <path>]
  prgenie address <id> <commentId> -m <message>
  prgenie resolve <id> <commentId> -m <message>
  prgenie edit-comment <id> <commentId> -m <message>
  prgenie delete-comment <id> <commentId> [--yes]
  prgenie complete-review <id> [-m <message>] [--force]
  prgenie status <id> <draft|ready|review_interrupted|changes_requested|reviewed|approved>
  prgenie worktrees
  prgenie worktree <id>
  prgenie learnings [--disabled] [--category <name>]
  prgenie disable-learning <id>
  prgenie enable-learning <id>
  prgenie delete-learning <id> [--yes]
  prgenie preflight <id>
  prgenie gh list
  prgenie gh status
  prgenie gh use <login>
  prgenie mcp [--smoke]

Run from any worktree. Loops are stored in the repo's .git/agent-console/.
`;
}

function attachUsage(): string {
  return `prgenie attach <pr-url|pr-number|branch> [--title <t>] [--body <b>] [--base <ref>]

Attach an existing GitHub PR or branch as a local loop.

Arguments:
  <pr-url|pr-number|branch>  GitHub PR URL, PR number, or branch name to attach

Options:
  --title <t>    Override the PR title
  --body <b>     Override the PR body
  --base <ref>   Override the base branch
  -h, --help     Show this help message
`;
}

export function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

/** Comment text from -m, --message, --body-file, or stdin when -m is -. */
export function messageArg(args: string[]): string | undefined {
  const file = arg(args, "--body-file");
  if (file) return readFileSync(file, "utf8");
  const message = arg(args, "-m") ?? arg(args, "--message");
  if (message === "-") return readFileSync(0, "utf8");
  return message;
}

export function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printPr(pr: LocalPr): void {
  const filesNote = pr.worktreePath
    ? `\n  worktree: ${pr.worktreePath}`
    : "\n  worktree: (gone — loop still exists)";
  const summary = pr.body.trim()
    ? `\n  summary: ${pr.body.trim().split("\n")[0].slice(0, 100)}`
    : "\n  summary: (none)";
  const exportUi = humanExportUi(pr);
  const exportNote =
    pr.status === "reviewed"
      ? `\n  export: ${
          exportUi.kind === "exportable"
            ? exportUi.listStatus
            : exportUi.kind === "blocked"
              ? `blocked — ${exportUi.blockedLabel}`
              : "pending (shepherd CI not green yet)"
        }`
      : "";
  const ciCwdNote =
    pr.exportGate?.ciCwd != null && pr.exportGate.ciCwd !== ""
      ? `\n  ci cwd: ${pr.exportGate.ciCwd}`
      : "";
  const envNote =
    pr.exportGate?.ciEnvUnhealthy?.message != null
      ? `\n  ci env: unhealthy — ${pr.exportGate.ciEnvUnhealthy.message}`
      : "";
  process.stdout.write(
    `${pr.id}  ${pr.status.padEnd(18)}  ${pr.headRef} -> ${pr.baseRef}\n  ${pr.title}${filesNote}${summary}${exportNote}${ciCwdNote}${envNote}\n`,
  );
  if (pr.worktreePath) {
    process.stdout.write(
      `  → Switch / open worktree before implementing (never commit on primary while this exists).\n`,
    );
  }
}

async function printGithubBind(cwd: string): Promise<void> {
  try {
    const bind = await describeRepoGithubBind(cwd);
    if (bind.bound) {
      process.stdout.write(`  gh bind: ${bind.login} on ${bind.host}\n`);
    } else if (bind.prompt) {
      process.stdout.write(`  gh bind: unbound — ${bind.prompt}\n`);
    }
  } catch {
    // ignore bind probe failures in print path
  }
}

async function cwdRepo(): Promise<string> {
  const cwd = process.cwd();
  const root = await findGitRoot(cwd);
  if (!root) {
    throw new Error("Not inside a git repository.");
  }
  return cwd;
}

function attachInterrupt(controller: AbortController): () => void {
  const onSig = () => controller.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  return () => {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  };
}

function printVerboseFailureLog(cwd: string, logPath: string | undefined): void {
  if (!logPath) return;
  try {
    const abs = path.isAbsolute(logPath) ? logPath : path.resolve(cwd, logPath);
    const body = readFileSync(abs, "utf8");
    process.stdout.write(`--- full log ${logPath} ---\n`);
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    process.stdout.write("---\n");
  } catch {
    process.stdout.write(`(full log missing: ${logPath})\n`);
  }
}

export async function run(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  if (args[0] === "version") {
    const { version } = await import("./version.js");
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (args[0] === "mcp") {
    if (flag(args.slice(1), "--smoke")) {
      const { bundledMcpServerPath, formatMcpSmoke, smokeMcpHandshake } =
        await import("./mcp-smoke.js");
      try {
        const result = await smokeMcpHandshake(bundledMcpServerPath(), 4000);
        process.stdout.write(formatMcpSmoke(result));
        const okSmoke =
          result.ready &&
          result.tools.includes("steward_next") &&
          result.tools.includes("bind_steward") &&
          result.elapsedMs < 4000;
        return okSmoke ? 0 : 1;
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return 0;
  }
  if (args[0] === "worktrees") {
    const trees = await listWorktrees(await cwdRepo());
    for (const t of trees) {
      process.stdout.write(`${t.branch ?? "(detached)"}  ${t.path}  ${t.head.slice(0, 8)}\n`);
    }
    return 0;
  }
  if (args[0] === "gh" || args[0] === "github") {
    return runGithub(args.slice(1));
  }
  const sub = args[0];
  const rest = args.slice(1);
  const repo = await cwdRepo();

  if (sub === "create") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie create [--title <t>] [--body <b>] [--base <ref>] [--head <ref>]\n\nCreate a new local PR.\n",
      );
      return 0;
    }
    const pr = await createLocalPr(repo, {
      title: arg(rest, "--title"),
      body: arg(rest, "--body"),
      base: arg(rest, "--base"),
      head: arg(rest, "--head"),
    });
    printPr(pr);
    await printGithubBind(repo);
    return 0;
  }
  if (sub === "attach") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(attachUsage());
      return 0;
    }
    const source = rest[0];
    if (!source) {
      process.stderr.write(
        "prgenie attach <pr-url|pr-number|branch> [--title <t>] [--body <b>] [--base <ref>]\n",
      );
      return 1;
    }
    const pr = await attachLocalPr(repo, {
      source,
      title: arg(rest, "--title"),
      body: arg(rest, "--body"),
      base: arg(rest, "--base"),
    });
    printPr(pr);
    return 0;
  }
  if (sub === "list") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie list [--all] [--search <q>] [--query <q>] [--in title,body,comment,file]\n\nList local PRs.\n",
      );
      return 0;
    }
    await archiveLoopsMergedOnGithub(repo).catch(() => []);
    const search = arg(rest, "--search") ?? arg(rest, "--query");
    const inRaw = arg(rest, "--in");
    const inFields = inRaw
      ? inRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const invalid = (inFields ?? []).filter(
      (f) => !["title", "body", "comment", "file"].includes(f),
    );
    if (invalid.length) {
      process.stderr.write(
        "--in fields must be title,body,comment,file (got: " + invalid.join(",") + ")\n",
      );
      return 1;
    }
    const all = await listLocalPrs(repo, {
      search,
      in: inFields as ("title" | "body" | "comment" | "file")[] | undefined,
    });
    const archived = all.filter(isArchivedPr);
    const prs = flag(rest, "--all") ? all : all.filter((pr) => !isArchivedPr(pr));
    if (prs.length === 0) {
      if (archived.length && !flag(rest, "--all")) {
        process.stdout.write(
          "No active local PRs. " + archived.length + " archived (prgenie list --all).\n",
        );
      } else if (search) {
        process.stdout.write("No local PRs matching search.\n");
      } else {
        process.stdout.write("No local PRs.\n");
      }
      return 0;
    }
    for (const pr of prs) printPr(pr);
    if (!flag(rest, "--all") && archived.length) {
      process.stdout.write("  (" + archived.length + " archived — prgenie list --all)\n");
    }
    return 0;
  }

  if (sub === "queue") {
    const ready = (await listLocalPrs(repo)).filter((pr) => pr.status === "ready");
    if (ready.length === 0) {
      process.stdout.write("No ready local PRs.\n");
      return 0;
    }
    for (const pr of ready) printPr(pr);
    return 0;
  }
  if (sub === "inbox") {
    const mine = await findLocalPrForCurrentWorktree(repo);
    if (!mine) {
      process.stdout.write("No live local PR on this worktree.\n");
      return 0;
    }
    const pending = pendingReviewComments(mine);
    if (mine.status !== "changes_requested" || pending.length === 0) {
      process.stdout.write(
        mine.status === "ready"
          ? "This worktree's loop is ready — wait for complete_review.\n"
          : "No pending review comments on this worktree.\n",
      );
      return 0;
    }
    printPr(mine);
    process.stdout.write(`  pending: ${pending.length}\n`);
    return 0;
  }
  if (sub === "doctor") {
    const report = await runDoctor(repo);
    process.stdout.write(formatDoctorReport(report));
    return report.ok ? 0 : 1;
  }
  if (sub === "watch") {
    const action = rest[0] ?? "status";
    if (action === "start" || action === "stop" || action === "listen") {
      process.stderr.write(`${LISTEN_REMOVED_MESSAGE}\n`);
      return 1;
    }
    const state = await getRepoWatch(repo);
    if (action === "inbox" || action === "queue") {
      process.stdout.write(`${formatWatchLane(state, action)}\n`);
      return 0;
    }
    process.stdout.write(formatWatchStatus(state));
    return 0;
  }

  if (sub === "sessions") {
    const limitRaw = arg(rest, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      process.stderr.write("--limit must be a positive number.\n");
      return 1;
    }
    const events = await listSessions(repo, {
      limit,
      hook: arg(rest, "--hook"),
      since: arg(rest, "--since"),
    });
    if (flag(rest, "--json")) {
      process.stdout.write(JSON.stringify(events, null, 2) + "\n");
      return 0;
    }
    if (events.length === 0) {
      process.stdout.write("No session events.\n");
      return 0;
    }
    for (const event of events) {
      process.stdout.write(formatSessionEvent(event) + "\n");
    }
    return 0;
  }
  if (sub === "export") {
    const exportId = rest[0];
    if (!exportId) {
      process.stderr.write("prgenie export <id> [--skip-validation] [--verbose]\n");
      return 1;
    }
    const exportVerbose = flag(rest, "--verbose") || flag(rest, "-v");
    process.stdout.write("Export: CI → push → create PR (20 min/check). Ctrl+C to cancel.\n");
    const ac = new AbortController();
    const detach = attachInterrupt(ac);
    let result: Awaited<ReturnType<typeof exportLocalPr>>;
    try {
      result = await exportLocalPr(repo, exportId, {
        skipValidation: flag(rest, "--skip-validation"),
        signal: ac.signal,
        onProgress: (event) => {
          process.stdout.write(`${formatProgressLine(event)}\n`);
          if (event.selectedChecks) {
            process.stdout.write(
              `CI plan: ${event.selectionReason ?? event.selectedChecks.join(", ")}\n`,
            );
          }
          if (exportVerbose && event.state === "fail") {
            printVerboseFailureLog(repo, event.logPath);
          }
        },
      });
    } catch (err) {
      if (isAbortError(err)) {
        process.stderr.write("Export cancelled.\n");
        return 130;
      }
      throw err;
    } finally {
      detach();
    }
    const lines = [`${result.alreadyExisted ? "Existing" : "Opened"} GitHub PR ${result.url}`];
    if (result.checkedOutBase) {
      lines.push("Main workspace is back on the loop base branch.");
    }
    if (result.prunedWorktree) {
      lines.push("Removed the extra loop worktree.");
    }
    if (result.partialFailure) {
      lines.push(formatExportPartialFailure(result.partialFailure));
    } else if (result.reopen && result.primaryPath) {
      lines.push(`This window is still on the loop worktree. Reopen ${result.primaryPath}.`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return result.partialFailure ? 1 : 0;
  }
  if (sub === "learnings" || sub === "learn") {
    const { listLearnings } = await import("@prgenie/core");
    const learnings = await listLearnings(repo, {
      disabled: flag(rest, "--disabled") ? true : undefined,
      category: arg(rest, "--category"),
    });
    if (learnings.length === 0) {
      process.stdout.write("No learnings.\n");
      return 0;
    }
    for (const learning of learnings) {
      const disabledFlag = learning.disabled ? " [disabled]" : "";
      const categoryFlag = learning.category ? ` [${learning.category}]` : "";
      process.stdout.write(
        `${learning.id}${disabledFlag}${categoryFlag} (from ${learning.sourcePrId} ${learning.sourceCommentId})\n`,
      );
      process.stdout.write(`  Pattern: ${learning.pattern}\n`);
      process.stdout.write(`  Guidance: ${learning.guidance}\n`);
      if (learning.path) process.stdout.write(`  Path: ${learning.path}\n`);
      process.stdout.write(`  Learned: ${learning.learnedAt}\n\n`);
    }
    return 0;
  }
  if (sub === "steward") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie steward [<id>] [--restart] [--implementor-missing] [--implementor-failed] [--json]\nprgenie steward bind <id> [--implementor <taskId>] [--reviewer <taskId>]\n\nOne steward per loop: persist Task ids and print the next implement/review/export-gate action.\n",
      );
      return 0;
    }
    if (rest[0] === "bind") {
      const bindId = rest[1];
      if (!bindId) {
        process.stderr.write(
          "prgenie steward bind <id> [--implementor <taskId>] [--reviewer <taskId>]\n",
        );
        return 1;
      }
      const binding = await bindSteward(repo, bindId, {
        implementorTaskId: arg(rest, "--implementor"),
        reviewerTaskId: arg(rest, "--reviewer"),
      });
      process.stdout.write(`${formatStewardBinding(binding)}\n`);
      return 0;
    }
    const stewardId = rest[0];
    if (!stewardId) {
      const bindings = await listStewardBindings(repo);
      if (bindings.length === 0) {
        process.stdout.write("No steward bindings.\n");
        return 0;
      }
      for (const binding of bindings) {
        process.stdout.write(`${formatStewardBinding(binding)}\n`);
      }
      return 0;
    }
    const card = createProgressCardSink((line) => process.stdout.write(`${line}\n`));
    const result = await stewardNext(repo, stewardId, {
      restart: flag(rest, "--restart"),
      implementorMissing: flag(rest, "--implementor-missing"),
      implementorFailed: flag(rest, "--implementor-failed"),
      reviewerMissing: flag(rest, "--reviewer-missing"),
      reviewerFailed: flag(rest, "--reviewer-failed"),
      onProgress: card.onProgress,
    });
    if (card.snapshot().checks.length) {
      process.stdout.write(`${card.card()}\n`);
    }
    if (flag(rest, "--json")) {
      process.stdout.write(
        `${JSON.stringify({ ...result, progressCard: card.card() }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${formatStewardDecision(result)}\n`);
    }
    return 0;
  }
  if (sub === "claim-review") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie claim-review <id> [--head <sha>] [--source <name>]\n\nClaim exclusive in-flight reviewer for this loop HEAD.\n",
      );
      return 0;
    }
    const claimId = rest[0];
    if (!claimId) {
      process.stderr.write("prgenie claim-review <id> [--head <sha>] [--source <name>]\n");
      return 1;
    }
    const result = await claimReview(repo, claimId, {
      headSha: arg(rest, "--head"),
      source: arg(rest, "--source") ?? "cli",
    });
    process.stdout.write(`${formatClaimReview(result)}\n`);
    return 0;
  }
  if (sub === "reconcile") {
    const targetId = rest[0];
    if (targetId) {
      const row = await reconcileOneLoop(repo, targetId);
      process.stdout.write(
        `${row.loopId}  ${row.status}  impl=${row.implementorTaskId ?? "-"}  rev=${row.reviewerTaskId ?? "-"}\n  → ${row.hint.replace("{id}", row.loopId)}\n`,
      );
      return 0;
    }
    const digest = await formatSessionReconnectDigest(repo);
    process.stdout.write((digest ?? "PR Genie session reconcile: no live loops.") + "\n");
    return 0;
  }
  const id = rest[0];
  if (!id) {
    process.stderr.write("Missing local PR id.\n");
    return 1;
  }
  if (sub === "show") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write("prgenie show <id>\n\nShow detailed information about a local PR.\n");
      return 0;
    }
    const pr = await refreshLocalPrHead(repo, id);
    const githubBind = await describeRepoGithubBind(repo);
    process.stdout.write(
      JSON.stringify({ ...pr, pendingComments: pendingReviewComments(pr), githubBind }, null, 2) +
        "\n",
    );
    const files = await getLocalPrNameStatus(repo, pr.id);
    if (files.length) {
      process.stdout.write("\nFiles:\n");
      for (const f of files) process.stdout.write(`  ${f.status}\t${f.path}\n`);
    }
    return 0;
  }
  if (sub === "shepherd") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie shepherd <id> [--verbose]\n\nRun the export gate (review + preflight + gh + local CI). --verbose prints the full capped CI log on failure.\n",
      );
      return 0;
    }
    const verbose = flag(rest, "--verbose") || flag(rest, "-v");
    process.stdout.write("Shepherd: local CI (20 min/check). Ctrl+C to cancel.\n");
    const ac = new AbortController();
    const detach = attachInterrupt(ac);
    const card = createProgressCardSink((line) => process.stdout.write(`${line}\n`));
    let result: Awaited<ReturnType<typeof evaluateAndStoreExportGate>>;
    try {
      result = await evaluateAndStoreExportGate(repo, id, {
        signal: ac.signal,
        onProgress: (event) => {
          card.onProgress(event);
          if (verbose && event.state === "fail") printVerboseFailureLog(repo, event.logPath);
        },
      });
    } catch (err) {
      if (isAbortError(err)) {
        process.stderr.write("Shepherd cancelled.\n");
        return 130;
      }
      throw err;
    } finally {
      detach();
    }
    process.stdout.write(`${card.card()}\n`);
    process.stdout.write(`Shepherd status: ${result.status}\n`);
    if (result.ciCwd) {
      process.stdout.write(`CI cwd: ${result.ciCwd}\n`);
    }
    if (result.ciPlan) {
      process.stdout.write(`CI plan: ${result.ciPlan.reason.join("; ")}\n`);
    }
    if (result.ciEnvUnhealthy) {
      process.stdout.write(`\nCI env unhealthy (does not hard-block export by default):\n`);
      process.stdout.write(`  ${result.ciEnvUnhealthy.message}\n`);
      for (const step of result.ciEnvUnhealthy.fixSteps) {
        process.stdout.write(`  - ${step}\n`);
      }
    }
    if (result.reasons.length > 0) {
      process.stdout.write("\nBlocking reasons:\n");
      for (const reason of result.reasons) {
        process.stdout.write(`  [${reason.check}] ${reason.message}\n`);
      }
    }
    return result.status === "ready" ? 0 : 1;
  }
  if (sub === "ci") {
    if (flag(rest, "-h") || flag(rest, "--help")) {
      process.stdout.write(
        "prgenie ci <id> [--failing <checks>] [--no-fail-fast] [--no-parallel] [--skip-cache]\n\nRun the same smart local CI shepherd will run (implementor preflight / CI-resume). Fix failures in the worktree before ready or returning from a gate resume.\n",
      );
      return 0;
    }
    const failing = (arg(rest, "--failing") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const card = createProgressCardSink((line) => process.stdout.write(`${line}\n`));
    const result = await runLoopCi(repo, id, {
      failingChecks: failing,
      failFast: flag(rest, "--no-fail-fast") ? false : undefined,
      parallel: flag(rest, "--no-parallel") ? false : undefined,
      skipCache: flag(rest, "--skip-cache"),
      onProgress: card.onProgress,
    });
    process.stdout.write(`${card.card()}\n`);
    if (result.cwd) {
      process.stdout.write(`CI cwd: ${result.cwd}\n`);
    }
    if (result.selection) {
      process.stdout.write(`CI plan checks: ${result.selection.checks.join(", ")}\n`);
      process.stdout.write(`CI plan reason: ${result.selection.reason.join("; ")}\n`);
    }
    if (result.envUnhealthy) {
      process.stdout.write(`CI env unhealthy: ${result.envMessage ?? "missing toolchain"}\n`);
      for (const step of result.fixSteps ?? []) {
        process.stdout.write(`  fix: ${step}\n`);
      }
    }
    process.stdout.write(result.allPassed ? "CI preflight passed.\n" : "CI preflight failed.\n");
    return result.allPassed ? 0 : 1;
  }
  if (sub === "update") {
    const title = arg(rest, "--title");
    const body = arg(rest, "--body");
    if (title === undefined && body === undefined) {
      process.stderr.write("prgenie update <id> [--title <t>] [--body <summary>]\n");
      return 1;
    }
    printPr(await updateLocalPr(repo, id, { title, body }));
    return 0;
  }
  if (sub === "diff") {
    const dash = rest.indexOf("--");
    const paths = dash >= 0 ? rest.slice(dash + 1) : [];
    process.stdout.write(
      await getLocalPrDiff(repo, id, {
        stat: flag(rest, "--stat"),
        paths: paths.length ? paths : undefined,
      }),
    );
    if (!flag(rest, "--stat")) process.stdout.write("\n");
    return 0;
  }
  if (sub === "delete") {
    if (!flag(rest, "--yes") && !flag(rest, "-y")) {
      process.stderr.write("prgenie delete <id> --yes\n");
      return 1;
    }
    const result = await deleteLocalPr(repo, id);
    process.stdout.write(`Deleted ${result.id}.\n`);
    return 0;
  }
  if (sub === "reopen") {
    printPr(await reopenLocalPr(repo, id));
    return 0;
  }
  if (sub === "worktree") {
    const pr = await getLocalPr(repo, id);
    const dest = await ensureWorktreeForLoop(repo, pr, {
      staleLoopIds: (await listLocalPrs(repo))
        .filter((p) => p.id !== pr.id && isArchivedPr(p))
        .map((p) => p.id),
      liveLoopIds: (await listLocalPrs(repo)).filter((p) => !isArchivedPr(p)).map((p) => p.id),
    });
    process.stdout.write(`${dest}\n`);
    return 0;
  }
  if (sub === "approve") {
    printPr(await setLocalPrStatus(repo, id, "approved"));
    return 0;
  }
  if (sub === "ready") {
    const ciSkip = arg(rest, "--ci-skip") ?? arg(rest, "--ci-skip-reason");
    printPr(
      await setLocalPrStatus(repo, id, "ready", {
        ciSkipReason: ciSkip,
      }),
    );
    await printGithubBind(repo);
    return 0;
  }
  if (sub === "review-interrupted") {
    printPr(
      await markReviewInterrupted(repo, id, {
        reason: arg(rest, "--reason") ?? messageArg(rest),
      }),
    );
    return 0;
  }
  if (sub === "review-resume") {
    printPr(await resumeReview(repo, id));
    const row = await reconcileOneLoop(repo, id);
    process.stdout.write(
      `  resume: implementor=${row.implementorTaskId ?? "-"}  reviewer=${row.reviewerTaskId ?? "-"}\n  → ${row.hint.replace("{id}", id)}\n`,
    );
    return 0;
  }
  if (sub === "request-changes") {
    const message = messageArg(rest);
    if (message) await addLocalPrComment(repo, id, message, { role: "human" });
    printPr(await setLocalPrStatus(repo, id, "changes_requested"));
    return 0;
  }
  if (sub === "comment") {
    const message = messageArg(rest);
    if (!message) {
      process.stderr.write(
        "prgenie comment <id> -m <message> [--body-file <path>] [--role human|agent|reviewer] [--path <file>] [--line <n>]\n",
      );
      return 1;
    }
    const role = (arg(rest, "--role") ?? "human") as CommentRole;
    const author = arg(rest, "--author");
    const filePath = arg(rest, "--path");
    const lineRaw = arg(rest, "--line");
    const sideRaw = arg(rest, "--side");
    printPr(
      await addLocalPrComment(repo, id, message, {
        role,
        author,
        path: filePath,
        line: lineRaw ? Number(lineRaw) : undefined,
        side: sideRaw === "left" || sideRaw === "right" ? sideRaw : undefined,
        replyTo: arg(rest, "--reply-to"),
      }),
    );
    return 0;
  }
  if (sub === "address") {
    const commentId = rest[1];
    const message = messageArg(rest);
    if (!commentId || !message) {
      process.stderr.write("prgenie address <id> <commentId> -m <message>\n");
      return 1;
    }
    printPr(await addressLocalPrComment(repo, id, commentId, message));
    return 0;
  }
  if (sub === "resolve") {
    const commentId = rest[1];
    const message = messageArg(rest);
    if (!commentId || !message) {
      process.stderr.write("prgenie resolve <id> <commentId> -m <message>\n");
      return 1;
    }
    printPr(await resolveLocalPrComment(repo, id, commentId, message, { role: "reviewer" }));
    return 0;
  }
  if (sub === "edit-comment") {
    const commentId = rest[1];
    const message = messageArg(rest);
    if (!commentId || !message) {
      process.stderr.write("prgenie edit-comment <id> <commentId> -m <message>\n");
      return 1;
    }
    printPr(await editLocalPrComment(repo, id, commentId, message));
    return 0;
  }
  if (sub === "delete-comment") {
    const commentId = rest[1];
    if (!commentId) {
      process.stderr.write("prgenie delete-comment <id> <commentId> [--yes]\n");
      return 1;
    }
    if (!flag(rest, "--yes") && !flag(rest, "-y")) {
      process.stderr.write("Pass --yes to permanently delete an open finding.\n");
      return 1;
    }
    printPr(await deleteLocalPrComment(repo, id, commentId));
    return 0;
  }
  if (sub === "complete-review") {
    try {
      const before = await refreshLocalPrHead(repo, id);
      if (pendingReviewComments(before).length === 0 && !isArchivedPr(before)) {
        await requireGithubBindForReviewed(repo);
      }
      const done = await completeLocalPrReview(repo, id, {
        body: messageArg(rest),
        allowDrift: flag(rest, "--force") || flag(rest, "--allow-drift"),
      });
      if (done.headDrift) {
        process.stderr.write(
          `warning: finalized despite head drift (${done.reviewedAgainstSha?.slice(0, 8)} → ${done.headSha.slice(0, 8)}).\n`,
        );
      }
      printPr(done);
      await printGithubBind(repo);
      return 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }
  if (sub === "status") {
    const status = rest[1] as LocalPrStatus;
    if (status === "reviewed") {
      await requireGithubBindForReviewed(repo);
    }
    printPr(await setLocalPrStatus(repo, id, status));
    await printGithubBind(repo);
    return 0;
  }
  if (sub === "disable-learning") {
    const { disableLearning } = await import("@prgenie/core");
    const learning = await disableLearning(repo, id);
    process.stdout.write(`Disabled learning ${learning.id}\n`);
    return 0;
  }
  if (sub === "enable-learning") {
    const { enableLearning } = await import("@prgenie/core");
    const learning = await enableLearning(repo, id);
    process.stdout.write(`Enabled learning ${learning.id}\n`);
    return 0;
  }
  if (sub === "delete-learning") {
    const { deleteLearning } = await import("@prgenie/core");
    if (!flag(rest, "--yes")) {
      process.stderr.write("Pass --yes to permanently delete a learning.\n");
      return 1;
    }
    const result = await deleteLearning(repo, id);
    process.stdout.write(`Deleted learning ${result.id}\n`);
    return 0;
  }
  if (sub === "preflight") {
    const { runPreflight } = await import("@prgenie/core");
    const pr = await getLocalPr(repo, id);
    const result = await runPreflight(repo, pr);
    if (result.passed) {
      process.stdout.write("✓ Preflight passed — no learned patterns detected.\n");
      return 0;
    }
    process.stdout.write(`✗ Preflight failed — ${result.issues.length} issue(s):\n\n`);
    for (const issue of result.issues) {
      process.stdout.write(`[${issue.learningId}] matched in ${issue.matchedIn}\n`);
      process.stdout.write(`  Pattern: ${issue.pattern}\n`);
      process.stdout.write(`  Guidance: ${issue.guidance}\n`);
      if (issue.path) process.stdout.write(`  Path: ${issue.path}\n`);
      process.stdout.write("\n");
    }
    return 1;
  }
  process.stderr.write(usage());
  return 1;
}

async function runGithub(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "status" || sub === "list") {
    const accounts = await listGhAccounts();
    if (accounts.length === 0) {
      process.stdout.write("No GitHub accounts. Run: gh auth login\n");
      return 1;
    }
    const cwd = process.cwd();
    const bind = (await findGitRoot(cwd)) ? await getRepoGithubBind(cwd) : null;
    for (const account of accounts) {
      const flags = [
        account.active ? "active" : "",
        bind && bind.login === account.login && bind.host === account.host ? "this-repo" : "",
      ]
        .filter(Boolean)
        .join(", ");
      process.stdout.write(`${account.host}  ${account.login}${flags ? `  (${flags})` : ""}\n`);
    }
    if ((await findGitRoot(cwd)) && !bind) {
      process.stdout.write("This repo is unbound. prgenie gh use <login>\n");
    }
    return 0;
  }
  if (sub === "use") {
    const login = args[1];
    if (!login) {
      process.stderr.write("prgenie gh use <login>\n");
      return 1;
    }
    const bind = await bindRepoGithub(await cwdRepo(), login);
    process.stdout.write(`Bound this repo to ${bind.login} on ${bind.host} and switched gh.\n`);
    return 0;
  }
  process.stderr.write(usage());
  return 1;
}
