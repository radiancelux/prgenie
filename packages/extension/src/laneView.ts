import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  addLocalPrComment,
  addressLocalPrComment,
  archiveLoopsMergedOnGithub,
  attachLocalPr,
  bindRepoGithub,
  commentThreads,
  completeLocalPrReview,
  consoleDir,
  createLocalPr,
  deleteLocalPr,
  deleteLocalPrComment,
  editLocalPrComment,
  ensureWorktreeForLoop,
  findGitRoot,
  getLocalPrNameStatus,
  getRepoGithubBind,
  isArchivedPr,
  listGhAccounts,
  listLocalPrs,
  loopWorktreeIdentity,
  pruneArchivedLoopWorktree,
  reopenLocalPr,
  resolveLocalPrComment,
  sameFsPath,
  setLocalPrStatus,
  shepherdStatus,
  updateLocalPr,
  exportLocalPr,
  abortExportGate,
  applyCiProgressEvent,
  emptyCiProgressSnapshot,
  evaluateAndStoreExportGate,
  displayShepherdStatus,
  exportGateSnapshotIsAdoptable,
  formatProgressStep,
  isAbortError,
  readCiFailureLog,
  HUMAN_EXPORT_COMPOSER_HINT,
  HUMAN_EXPORT_DISMISS_ACTION,
  HUMAN_EXPORT_PRIMARY_ACTION,
  humanExportConfirmMessage,
  humanExportEnterMessage,
  humanExportUi,
  nextExportReadyEnter,
  retainExportReadyNotified,
  type LocalPr,
  type HumanExportUi,
  type ProgressEvent,
  type ShepherdResult,
  type GhAccount,
  type RepoGithubBind,
} from "@prgenie/core";
import { openAllChanges, openFileChange } from "./gitDiff.js";
import {
  CHEAP_SHEPHERD_DEBOUNCE_MS,
  createCheapShepherdScheduler,
  createCoalescingFlight,
  createExportGateScheduler,
  SIDEBAR_SHEPHERD_OPTIONS,
} from "./sidebarPoller.js";
import {
  STATUS_PANEL_TITLE,
  exportBusyHelper,
  statusPanelGuidanceForLoop,
  statusPanelIdleBody,
} from "./statusPanel.js";

type Surface = "lane" | "panel";

type ClientMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "create" }
  | { type: "attach" }
  | { type: "select"; id: string }
  | { type: "status"; id: string; status: LocalPr["status"] }
  | { type: "comment"; id: string; body: string }
  | { type: "summary"; id: string; body: string }
  | { type: "copyReviewPrompt"; id: string }
  | { type: "openFolder"; id: string }
  | { type: "openGitLens" }
  | { type: "openFile"; path: string; status: string }
  | { type: "openComment"; path: string; line?: number }
  | { type: "address"; id: string; commentId: string }
  | { type: "resolve"; id: string; commentId: string }
  | { type: "editComment"; id: string; commentId: string; body?: string }
  | { type: "deleteComment"; id: string; commentId: string }
  | { type: "completeReview"; id: string; force?: boolean }
  | { type: "deletePr"; id: string }
  | { type: "reopenPr"; id: string }
  | { type: "renamePr"; id: string }
  | { type: "openDiffs" }
  | { type: "export"; id: string }
  | { type: "cancelProgress" }
  | { type: "retryProgress"; id: string }
  | { type: "openTerminal"; id: string }
  | {
      type: "openCiDetail";
      check: string;
      state?: string;
      excerpt?: string;
      logPath?: string;
      elapsedMs?: number;
      reason?: string;
    }
  | { type: "showArchived"; value: boolean }
  | { type: "ghBind"; login: string }
  | { type: "ghRefresh" }
  | { type: "search"; query: string };

type GhBindSnapshot = {
  accounts: GhAccount[];
  bound: RepoGithubBind | null;
  error?: string;
};

type SidebarPr = LocalPr & { humanExport: HumanExportUi };

type LiveCheck = {
  name: string;
  state: string;
  elapsedMs?: number;
  command?: string;
  message?: string;
  logPath?: string;
  reason?: string;
};

type LiveProgress = {
  id: string;
  kind: "gate" | "export";
  step: string;
  phase: string;
  check?: string;
  state: string;
  command?: string;
  message?: string;
  logPath?: string;
  elapsedMs?: number;
  cancellable: boolean;
  failed?: boolean;
  cancelled?: boolean;
  checks?: LiveCheck[];
  selectionReason?: string;
  cwd?: string;
};

type Snapshot = {
  type: "snapshot";
  error?: string;
  prs: SidebarPr[];
  selectedId: string | null;
  files: { status: string; path: string }[];
  threads?: { root: LocalPr["comments"][number]; replies: LocalPr["comments"] }[];
  repo: string;
  freshIds: string[];
  watching: boolean;
  hereId: string | null;
  archivedCount?: number;
  showArchived?: boolean;
  titleSaveInFlightId?: string | null;
  ghBind?: GhBindSnapshot;
  shepherdStatus?: ShepherdResult | null;
  progress?: LiveProgress | null;
  ciPlan?: { checks: string[]; reason: string | string[] } | null;
  ciChecks?: LiveCheck[] | null;
  /** Persisted path CI ran in (exportGate.ciCwd) — shown after live progress clears. */
  ciCwd?: string | null;
  searchQuery?: string;
};

export class LaneHub implements vscode.Disposable {
  private readonly views = new Map<Surface, vscode.WebviewView>();
  private watcher: FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedId: string | undefined;
  private knownIds = new Set<string>();
  private primed = false;
  private userPinned = false;
  private lastPosted = "";
  private reopeningMain = false;
  private lastGithubArchive = 0;
  private showArchived = false;
  private titleSaveInFlightId: string | undefined;
  private lastShepherd: ShepherdResult | null = null;
  private lastShepherdId: string | undefined;
  private archiveInFlight = false;
  private readonly enqueueSnapshot: (force?: boolean) => Promise<void>;
  private readonly cheapShepherd = createCheapShepherdScheduler({
    debounceMs: CHEAP_SHEPHERD_DEBOUNCE_MS,
    fetch: (root, id) => shepherdStatus(root, id, SIDEBAR_SHEPHERD_OPTIONS),
    onResult: (id, result) => {
      this.lastShepherdId = id;
      this.lastShepherd = result;
      void this.pushSnapshot();
    },
    onError: (err) => {
      console.error("[prgenie] Failed to fetch shepherd status:", err);
    },
  });
  private readonly exportGate = createExportGateScheduler({
    evaluate: (root, id, ctx) =>
      evaluateAndStoreExportGate(root, id, {
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      }).then(() => undefined),
    onStart: (id) => {
      if (this.exportBusy) return;
      this.ciSnap = emptyCiProgressSnapshot();
      this.setLiveProgress({
        id,
        kind: "gate",
        step: "CI checks",
        phase: "ci",
        state: "start",
        cancellable: true,
      });
    },
    onProgress: (id, event) => {
      if (this.exportBusy) return;
      this.emitProgress("gate", id, event);
    },
    onDone: () => {
      if (!this.exportBusy) this.clearLiveProgress();
      void this.pushSnapshot();
    },
    onError: (err, id) => {
      if (isAbortError(err)) {
        this.setLiveProgress({
          id,
          kind: "gate",
          step: "Cancelled",
          phase: "ci",
          state: "cancelled",
          cancellable: false,
          cancelled: true,
        });
      } else {
        console.error("[prgenie] Failed to evaluate export gate:", err);
        if (!this.exportBusy) this.clearLiveProgress();
      }
      void this.pushSnapshot();
    },
  });
  private exportReadyPromptInFlight = false;
  private liveProgress: LiveProgress | null = null;
  private ciSnap = emptyCiProgressSnapshot();
  private exportBusy = false;
  /** Loop id currently exporting — keeps selection/visual primary stable (RAD-124). */
  private exportingId: string | null = null;
  private exportAbort: AbortController | null = null;
  private searchQuery = "";

  constructor(private readonly context: vscode.ExtensionContext) {
    this.showArchived = this.context.workspaceState.get("prgenie.showArchived", false);
    this.searchQuery = this.context.workspaceState.get("prgenie.searchQuery", "");
    this.enqueueSnapshot = createCoalescingFlight((force) => this.pushSnapshotWork(force));
    this.poller = setInterval(() => void this.pushSnapshot(), 2000);
  }

  provider(surface: Surface): vscode.WebviewViewProvider {
    return {
      resolveWebviewView: (webviewView) => this.resolve(surface, webviewView),
    };
  }

  refresh(): void {
    void this.pushSnapshot(true);
  }

  async switchSelected(): Promise<void> {
    if (!this.selectedId) {
      void vscode.window.showInformationMessage("Select a loop in Local PRs first.");
      return;
    }
    await this.onMessage({ type: "openFolder", id: this.selectedId });
  }

  async createPr(): Promise<void> {
    const cwd = await this.repoCwd();
    if (!cwd) return;
    const title = await vscode.window.showInputBox({
      title: "PR Genie",
      prompt: "Local PR title",
    });
    if (title === undefined) return;
    const body = await vscode.window.showInputBox({
      title: "PR Genie",
      prompt: "Summary for reviewers (why, what changed, how to test)",
    });
    if (body === undefined) return;
    try {
      const pr = await createLocalPr(cwd, {
        title: title || undefined,
        body: body || undefined,
        source: { kind: "extension" },
      });
      this.selectedId = pr.id;
      this.userPinned = true;
      await this.pushSnapshot();
      await vscode.commands.executeCommand("prgenie.panel.focus");
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async attachPr(): Promise<void> {
    const cwd = await this.repoCwd();
    if (!cwd) return;
    const source = await vscode.window.showInputBox({
      title: "PR Genie - Attach",
      prompt: "GitHub PR number (#123), PR URL, or branch name",
      placeHolder: "e.g., 123, https://github.com/org/repo/pull/123, or feat/branch",
    });
    if (!source) return;
    try {
      const pr = await attachLocalPr(cwd, {
        source,
        prSource: { kind: "extension" },
      });
      this.selectedId = pr.id;
      this.userPinned = true;
      await this.pushSnapshot();
      await vscode.commands.executeCommand("prgenie.panel.focus");
      void vscode.window.showInformationMessage(`Attached ${pr.headRef} as ${pr.id}`);
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async openGitLens(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const candidates = ["gitlens.showGraph", "gitlens.showCommitGraph", "gitlens.showGraphPage"];
    const found = candidates.find((c) => commands.includes(c));
    if (found) {
      await vscode.commands.executeCommand(found);
      return;
    }
    void vscode.window.showInformationMessage(
      "GitLens is not installed. Install it for history and the commit graph; PR Genie only shows local review loops.",
    );
  }

  dispose(): void {
    this.watcher?.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.poller) clearInterval(this.poller);
  }

  private resolve(surface: Surface, webviewView: vscode.WebviewView): void {
    this.views.set(surface, webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html =
      surface === "lane" ? laneHtml(webviewView.webview) : panelHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
      void this.onMessage(msg);
    });
    webviewView.onDidDispose(() => {
      if (this.views.get(surface) === webviewView) this.views.delete(surface);
    });
    void this.watchStore();
    void this.pushSnapshot(true);
  }

  private async repoCwd(options: { warn?: boolean } = { warn: true }): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      if (options.warn) {
        void vscode.window.showWarningMessage("Open a git repository folder.");
      }
      return undefined;
    }
    const root = await findGitRoot(folder.uri.fsPath);
    if (!root) {
      void vscode.window.showWarningMessage("The open folder is not a git repository.");
      return undefined;
    }
    return root;
  }

  private async watchStore(): Promise<void> {
    if (this.watcher) return;
    const cwd = await this.repoCwd({ warn: false });
    if (!cwd) return;
    try {
      const dir = await consoleDir(cwd);
      this.watcher = watch(dir, { recursive: true }, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.pushSnapshot(), 150);
      });
    } catch {
      // Store created on first local PR.
    }
  }

  private async rejectIfArchived(cwd: string, id: string): Promise<boolean> {
    const prs = await listLocalPrs(cwd);
    const pr = prs.find((p) => p.id === id);
    if (pr && isArchivedPr(pr)) {
      void vscode.window.showInformationMessage("This loop is archived. The record is read-only.");
      return true;
    }
    return false;
  }

  private emitProgress(kind: "gate" | "export", id: string, event: ProgressEvent): void {
    this.ciSnap = applyCiProgressEvent(this.ciSnap, event);
    this.setLiveProgress({
      id,
      kind,
      step: formatProgressStep(event, kind),
      phase: event.phase,
      check: event.check,
      state: event.state,
      command: event.command,
      message: event.message,
      logPath: event.logPath,
      elapsedMs: event.elapsedMs,
      cancellable: true,
      failed: event.state === "fail",
      checks: this.ciSnap.checks,
      selectionReason: this.ciSnap.selectionReason,
      cwd: this.ciSnap.cwd,
    });
  }

  private setLiveProgress(progress: LiveProgress): void {
    this.liveProgress = progress;
    this.postLiveProgress();
  }

  private clearLiveProgress(): void {
    this.liveProgress = null;
    this.postLiveProgress();
  }

  private postLiveProgress(): void {
    for (const view of this.views.values()) {
      void view.webview.postMessage({ type: "progress", progress: this.liveProgress });
    }
  }

  private async exportLoop(
    cwd: string,
    id: string,
    options: { confirmed?: boolean } = {},
  ): Promise<void> {
    if (this.exportBusy) {
      void vscode.window.showInformationMessage("Export already running.");
      return;
    }
    if (await this.rejectIfArchived(cwd, id)) return;
    this.exportBusy = true;
    this.exportingId = id;
    this.selectedId = id;
    this.userPinned = true;
    try {
      const prs = await listLocalPrs(cwd);
      const pr = prs.find((p) => p.id === id);
      const title = pr?.title ?? id;
      if (!options.confirmed) {
        const pick = await vscode.window.showInformationMessage(
          humanExportConfirmMessage(title),
          { modal: true },
          HUMAN_EXPORT_PRIMARY_ACTION,
        );
        if (pick !== HUMAN_EXPORT_PRIMARY_ACTION) return;
      }
      const ac = new AbortController();
      this.exportAbort = ac;
      this.ciSnap = emptyCiProgressSnapshot();
      // RAD-124: distinguish re-running gate CI vs reusing a green gate vs push/create PR.
      const reuseGreenGate = Boolean(
        pr &&
        pr.exportGate?.status === "ready" &&
        exportGateSnapshotIsAdoptable(pr.exportGate, pr.headSha),
      );
      if (reuseGreenGate) {
        this.setLiveProgress({
          id,
          kind: "export",
          step: "Reusing green gate",
          phase: "preflight",
          state: "cached",
          cancellable: true,
        });
      } else {
        this.setLiveProgress({
          id,
          kind: "export",
          step: "Re-running gate CI",
          phase: "ci",
          state: "start",
          cancellable: true,
        });
      }
      await this.pushSnapshot(true);
      try {
        const result = await exportLocalPr(cwd, id, {
          signal: ac.signal,
          onProgress: (event) => this.emitProgress("export", id, event),
        });
        this.clearLiveProgress();
        await this.pushSnapshot(true);
        const open = await vscode.window.showInformationMessage(
          result.alreadyExisted
            ? `GitHub PR already exists: ${result.url}`
            : `Opened ${result.url}`,
          "Open",
        );
        if (open === "Open") await vscode.env.openExternal(vscode.Uri.parse(result.url));
      } catch (err) {
        if (isAbortError(err)) {
          this.setLiveProgress({
            id,
            kind: "export",
            step: "Cancelled",
            phase: "ci",
            state: "cancelled",
            cancellable: false,
            cancelled: true,
          });
          void vscode.window.showInformationMessage("Export cancelled.");
          return;
        }
        this.clearLiveProgress();
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        await this.pushSnapshot(true);
      } finally {
        this.exportAbort = null;
      }
    } finally {
      this.exportBusy = false;
      this.exportingId = null;
    }
  }

  private async promptExportReadyEnter(prs: SidebarPr[]): Promise<void> {
    const stored = this.context.workspaceState.get<string[]>("prgenie.exportReadyNotified", []);
    const retained = retainExportReadyNotified(prs, stored);
    if (retained.length !== stored.length || retained.some((key, i) => key !== stored[i])) {
      await this.context.workspaceState.update("prgenie.exportReadyNotified", retained);
    }
    const next = nextExportReadyEnter(prs, retained);
    if (!next || this.exportReadyPromptInFlight) return;
    this.exportReadyPromptInFlight = true;
    try {
      await this.context.workspaceState.update("prgenie.exportReadyNotified", [
        ...retained,
        next.key,
      ]);
      const pick = await vscode.window.showInformationMessage(
        humanExportEnterMessage(next.title),
        HUMAN_EXPORT_PRIMARY_ACTION,
        HUMAN_EXPORT_DISMISS_ACTION,
      );
      if (pick !== HUMAN_EXPORT_PRIMARY_ACTION) return;
      const cwd = await this.repoCwd({ warn: false });
      if (!cwd) return;
      await this.exportLoop(cwd, next.id, { confirmed: true });
    } finally {
      this.exportReadyPromptInFlight = false;
    }
  }

  private async onMessage(msg: ClientMessage): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "search") {
      this.searchQuery = msg.query;
      await this.context.workspaceState.update("prgenie.searchQuery", msg.query);
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "showArchived") {
      this.showArchived = msg.value;
      await this.context.workspaceState.update("prgenie.showArchived", msg.value);
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "ghBind") {
      const cwd = await this.repoCwd();
      if (!cwd) return;
      try {
        await bindRepoGithub(cwd, msg.login);
        void vscode.window.showInformationMessage(
          `Bound this repo to ${msg.login} and switched gh.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        await this.pushSnapshot(true);
      }
      return;
    }
    if (msg.type === "ghRefresh") {
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "cancelProgress") {
      this.exportAbort?.abort();
      this.exportGate.cancel();
      const cancelCwd = await this.repoCwd({ warn: false });
      const cancelId = this.selectedId ?? this.liveProgress?.id;
      if (cancelCwd && cancelId) abortExportGate(cancelCwd, cancelId);
      return;
    }
    if (msg.type === "openTerminal") {
      const termCwd = await this.repoCwd();
      if (!termCwd) return;
      const termPrs = await listLocalPrs(termCwd);
      const termPr = termPrs.find((p) => p.id === msg.id);
      if (!termPr?.worktreePath || !existsSync(termPr.worktreePath)) {
        void vscode.window.showErrorMessage(
          `Loop worktree is missing${termPr ? ` (${termPr.id})` : ""}. Switch to this loop to recreate it.`,
        );
        return;
      }
      const term = vscode.window.createTerminal({ name: termPr.id, cwd: termPr.worktreePath });
      term.show(true);
      return;
    }
    if (msg.type === "openCiDetail") {
      const detailCwd = await this.repoCwd({ warn: false });
      let log = "";
      if (detailCwd && msg.logPath) {
        log = (await readCiFailureLog(detailCwd, msg.logPath)) ?? "";
      }
      for (const view of this.views.values()) {
        void view.webview.postMessage({
          type: "ciDetail",
          check: msg.check,
          state: msg.state ?? "",
          excerpt: msg.excerpt ?? "",
          log,
          logPath: msg.logPath ?? "",
          elapsedMs: msg.elapsedMs,
          reason: msg.reason ?? "",
        });
      }
      return;
    }
    if (msg.type === "retryProgress") {
      const retryCwd = await this.repoCwd();
      if (!retryCwd) return;
      const retryPrs = await listLocalPrs(retryCwd);
      const retryPr = retryPrs.find((p) => p.id === msg.id);
      if (!retryPr) return;
      this.clearLiveProgress();
      this.exportGate.retry(retryCwd, retryPr);
      return;
    }
    if (msg.type === "create") {
      await this.createPr();
      return;
    }
    if (msg.type === "attach") {
      await this.attachPr();
      return;
    }
    if (msg.type === "openGitLens") {
      await this.openGitLens();
      return;
    }
    if (msg.type === "openFile" || msg.type === "openDiffs") {
      const cwd = await this.repoCwd({ warn: false });
      if (!cwd) return;
      const prs = await listLocalPrs(cwd);
      const pr = prs.find((p) => p.id === this.selectedId);
      if (!pr) return;
      const files = await getLocalPrNameStatus(cwd, pr.id);
      if (msg.type === "openDiffs") {
        await openAllChanges(cwd, pr, files);
        return;
      }
      await openFileChange(cwd, pr, msg.status, msg.path);
      return;
    }
    if (msg.type === "openComment") {
      const cwd = await this.repoCwd({ warn: false });
      if (!cwd) return;
      try {
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === this.selectedId);
        const root = pr?.worktreePath || cwd;
        const uri = vscode.Uri.file(path.join(root, msg.path.replace(/\\/g, "/")));
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = msg.line && msg.line > 0 ? msg.line - 1 : 0;
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line, 0, line, 0),
        });
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const cwd = await this.repoCwd();
    if (!cwd) return;
    try {
      if (msg.type === "select") {
        this.selectedId = msg.id;
        this.userPinned = true;
        await this.pushSnapshot();
        await vscode.commands.executeCommand("prgenie.panel.focus");
      } else if (msg.type === "status") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        await setLocalPrStatus(cwd, msg.id, msg.status, {
          skipPreflight: msg.status === "ready" ? false : undefined,
        });
        await this.pushSnapshot();
      } else if (msg.type === "export") {
        await this.exportLoop(cwd, msg.id);
      } else if (msg.type === "comment") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        await addLocalPrComment(cwd, msg.id, msg.body, { role: "human" });
        await this.pushSnapshot();
      } else if (msg.type === "address") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const note = await vscode.window.showInputBox({
          title: "Address comment",
          prompt: "How did you address this? This reply sits under the reviewer comment.",
        });
        if (note === undefined) return;
        await addressLocalPrComment(cwd, msg.id, msg.commentId, note);
        await this.pushSnapshot();
      } else if (msg.type === "resolve") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const note = await vscode.window.showInputBox({
          title: "Resolve comment",
          prompt: "Confirm this is fixed. This marks the thread resolved for human review.",
        });
        if (note === undefined) return;
        await resolveLocalPrComment(cwd, msg.id, msg.commentId, note, { role: "human" });
        await this.pushSnapshot();
      } else if (msg.type === "editComment") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        const existing = pr?.comments.find(
          (c) => c.id === msg.commentId || c.id.startsWith(msg.commentId),
        );
        const body = await vscode.window.showInputBox({
          title: "Edit finding",
          value: existing?.body ?? msg.body ?? "",
          prompt: "Update the open finding text.",
        });
        if (body === undefined) return;
        await editLocalPrComment(cwd, msg.id, msg.commentId, body);
        await this.pushSnapshot();
      } else if (msg.type === "deleteComment") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const pick = await vscode.window.showWarningMessage(
          "Delete this open finding and its replies?",
          { modal: true },
          "Delete",
        );
        if (pick !== "Delete") return;
        await deleteLocalPrComment(cwd, msg.id, msg.commentId);
        await this.pushSnapshot();
      } else if (msg.type === "completeReview") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const pick = await vscode.window.showInformationMessage(
          "Complete review? Open findings hand the loop to the implementor; none marks it reviewed.",
          { modal: true },
          "Complete review",
        );
        if (pick !== "Complete review") return;
        try {
          await completeLocalPrReview(cwd, msg.id, { allowDrift: msg.force === true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/HEAD moved since Review requested/i.test(message)) {
            const force = await vscode.window.showWarningMessage(
              `${message} Finalize anyway?`,
              { modal: true },
              "Force complete",
            );
            if (force !== "Force complete") return;
            await completeLocalPrReview(cwd, msg.id, { allowDrift: true });
          } else {
            throw err;
          }
        }
        await this.pushSnapshot();
      } else if (msg.type === "renamePr") {
        if (this.titleSaveInFlightId) return;
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        if (!pr) return;
        const title = await vscode.window.showInputBox({
          title: "Rename loop",
          prompt: "Local PR title",
          value: pr.title,
          validateInput: (value) => (value.trim() ? undefined : "Title is empty"),
        });
        if (title === undefined) return;
        if (title.trim() === pr.title.trim()) return;
        this.titleSaveInFlightId = msg.id;
        try {
          await this.pushSnapshot(true);
          await updateLocalPr(cwd, msg.id, { title });
        } finally {
          this.titleSaveInFlightId = undefined;
          await this.pushSnapshot(true);
        }
      } else if (msg.type === "deletePr") {
        const pick = await vscode.window.showWarningMessage(
          `Permanently delete loop ${msg.id}? This removes the packet and refs.`,
          { modal: true },
          "Delete",
        );
        if (pick !== "Delete") return;
        await deleteLocalPr(cwd, msg.id);
        if (this.selectedId === msg.id) this.selectedId = undefined;
        await this.pushSnapshot(true);
      } else if (msg.type === "reopenPr") {
        const reopened = await reopenLocalPr(cwd, msg.id);
        this.selectedId = reopened.id;
        this.userPinned = true;
        await this.pushSnapshot(true);
      } else if (msg.type === "summary") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        await updateLocalPr(cwd, msg.id, { body: msg.body });
        await this.pushSnapshot();
      } else if (msg.type === "copyReviewPrompt") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const prompt = [
          `Review local PR ${msg.id} with PR Genie.`,
          "Call get_diff. Post all findings with add_comment role=reviewer (status stays ready).",
          "Always complete_review last: open findings become changes_requested; none becomes reviewed.",
          "Do not implement fixes unless I ask. Do not git push.",
        ].join(" ");
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage(
          "Review prompt copied. Paste it in a new chat or run /review.",
        );
      } else if (msg.type === "openFolder") {
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        if (!pr) return;
        if (isArchivedPr(pr)) {
          void vscode.window.showInformationMessage(
            "This loop is archived. The worktree was removed after export. Use the panel to read the record.",
          );
          return;
        }
        const dest = await ensureWorktreeForLoop(cwd, pr, {
          staleLoopIds: prs.filter((p) => p.id !== pr.id && isArchivedPr(p)).map((p) => p.id),
          liveLoopIds: prs.filter((p) => !isArchivedPr(p)).map((p) => p.id),
        });
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (folder && sameFsPath(folder, dest)) {
          void vscode.window.showInformationMessage("This window is already on that loop.");
          return;
        }
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), {
          forceNewWindow: false,
        });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private post(
    payload: Snapshot | { type: "snapshot"; error: string; prs: [] },
    force = false,
  ): void {
    const sig = snapshotKey(payload);
    if (!force && sig === this.lastPosted) return;
    this.lastPosted = sig;
    for (const view of this.views.values()) {
      void view.webview.postMessage(payload);
    }
  }

  private pushSnapshot(force = false): Promise<void> {
    return this.enqueueSnapshot(force);
  }

  /** Fire-and-forget merged-PR archive. Must not block first paint (RCA Slice 0). */
  private scheduleGithubArchive(root: string, force: boolean): void {
    const due = force || Date.now() - this.lastGithubArchive > 30_000;
    if (!due || this.archiveInFlight) return;
    this.archiveInFlight = true;
    this.lastGithubArchive = Date.now();
    void archiveLoopsMergedOnGithub(root)
      .then((ids) => {
        if (ids.length > 0) void this.pushSnapshot();
      })
      .catch(() => [])
      .finally(() => {
        this.archiveInFlight = false;
      });
  }

  private async pushSnapshotWork(force = false): Promise<void> {
    if (this.views.size === 0) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.post({ type: "snapshot", error: "Open a git repository.", prs: [] }, force);
      return;
    }
    const root = await findGitRoot(cwd);
    if (!root) {
      this.post({ type: "snapshot", error: "Not a git repository.", prs: [] }, force);
      return;
    }
    const parked = loopWorktreeIdentity(root);
    if (parked) {
      try {
        const parkedPrs = await listLocalPrs(root);
        const parkedLoop = parkedPrs.find((p) => p.id === parked.id);
        if (!parkedLoop || isArchivedPr(parkedLoop)) {
          const liveHere = parkedPrs.some(
            (p) =>
              !isArchivedPr(p) &&
              (p.id === parked.id || (p.worktreePath && sameFsPath(p.worktreePath, root))),
          );
          if (!liveHere && !this.reopeningMain) {
            this.reopeningMain = true;
            await vscode.commands.executeCommand(
              "vscode.openFolder",
              vscode.Uri.file(parked.primaryPath),
              { forceNewWindow: false },
            );
          }
          if (!liveHere) return;
        }
      } catch {
        // Store may not exist yet.
      }
    }
    try {
      this.scheduleGithubArchive(root, force);
      const all = await listLocalPrs(root, {
        search: this.searchQuery || undefined,
      });
      const livePaths = all
        .filter((p) => !isArchivedPr(p) && p.worktreePath)
        .map((p) => p.worktreePath as string);
      for (const pr of all.filter(isArchivedPr)) {
        const ident = pr.worktreePath ? loopWorktreeIdentity(pr.worktreePath) : null;
        if (ident && ident.id.toLowerCase() === pr.id.toLowerCase()) {
          await pruneArchivedLoopWorktree(root, pr, { keepPaths: livePaths });
        }
      }
      const archivedCount = all.filter(isArchivedPr).length;
      const live = all.filter((p) => !isArchivedPr(p));
      const archived = all.filter(isArchivedPr);
      const prs = this.showArchived ? [...live, ...archived] : live;
      const ids = live.map((p) => p.id);
      const freshIds = this.primed ? ids.filter((id) => !this.knownIds.has(id)) : [];
      this.primed = true;
      for (const id of ids) this.knownIds.add(id);
      // RAD-124: while export is busy, keep the exporting loop selected even if a
      // draft sibling updates and would otherwise become "fresh" / top of list.
      if (this.exportBusy && this.exportingId && prs.some((p) => p.id === this.exportingId)) {
        this.selectedId = this.exportingId;
      } else {
        if (freshIds.length && !this.userPinned) this.selectedId = freshIds[0];
        if (this.selectedId && !prs.some((p) => p.id === this.selectedId)) {
          this.selectedId = live[0]?.id ?? (this.showArchived ? archived[0]?.id : undefined);
        }
        if (!this.selectedId)
          this.selectedId = live[0]?.id ?? (this.showArchived ? archived[0]?.id : undefined);
      }
      const selected = prs.find((p) => p.id === this.selectedId);
      let files: { status: string; path: string }[] = [];
      try {
        files = selected ? await getLocalPrNameStatus(root, selected.id) : [];
      } catch {
        files = [];
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const hereId =
        prs.find((p) => p.worktreePath && sameFsPath(p.worktreePath, folder))?.id ?? null;
      let ghBind: GhBindSnapshot | undefined;
      try {
        const [accounts, bound] = await Promise.all([listGhAccounts(), getRepoGithubBind(root)]);
        ghBind = { accounts, bound };
      } catch (err) {
        console.error("[prgenie] Failed to fetch gh bind state:", err);
        ghBind = {
          accounts: [],
          bound: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const cheap = selected && this.lastShepherdId === selected.id ? this.lastShepherd : null;
      // Only surface STATUS shepherd chrome (ready/blocked) once the loop is past review.
      // Draft/ready/changes_requested cheap results must not paint BLOCKED (RAD-83 / RAD-110).
      const shepherd =
        selected && selected.status === "reviewed" ? displayShepherdStatus(cheap, selected) : null;
      const sidebarPrs = prs.map((pr) => ({ ...pr, humanExport: humanExportUi(pr) }));
      void this.promptExportReadyEnter(sidebarPrs);
      this.post(
        {
          type: "snapshot",
          prs: sidebarPrs,
          selectedId: this.selectedId ?? null,
          files,
          threads: selected ? commentThreads(selected.comments) : [],
          repo: path.basename(root),
          freshIds,
          watching: true,
          hereId,
          archivedCount,
          showArchived: this.showArchived,
          titleSaveInFlightId: this.titleSaveInFlightId ?? null,
          ghBind,
          shepherdStatus: shepherd,
          progress: this.liveProgress,
          ciPlan: selected?.exportGate?.ciPlan ?? null,
          ciChecks: (selected?.exportGate?.ciChecks ?? []).map((c) => ({
            name: c.name,
            state: c.skipped ? "skip" : c.passed ? "pass" : "fail",
            elapsedMs: c.elapsedMs,
            message: c.excerpt,
            logPath: c.logPath,
            reason: c.reason,
          })),
          ciCwd: selected?.exportGate?.ciCwd ?? null,
          searchQuery: this.searchQuery,
        },
        force,
      );
      this.cheapShepherd.schedule(root, selected?.id);
      this.exportGate.schedule(root, selected);
      await this.watchStore();
    } catch (err) {
      this.post(
        {
          type: "snapshot",
          error: err instanceof Error ? err.message : String(err),
          prs: [],
        },
        force,
      );
    }
  }
}

function snapshotKey(payload: Snapshot | { type: "snapshot"; error: string; prs: [] }): string {
  return JSON.stringify({
    error: payload.error ?? null,
    selectedId: "selectedId" in payload ? payload.selectedId : null,
    hereId: "hereId" in payload ? payload.hereId : null,
    archivedCount: "archivedCount" in payload ? payload.archivedCount : 0,
    showArchived: "showArchived" in payload ? payload.showArchived : false,
    titleSaveInFlightId: "titleSaveInFlightId" in payload ? payload.titleSaveInFlightId : null,
    repo: "repo" in payload ? payload.repo : "",
    files: "files" in payload ? payload.files : [],
    threads: "threads" in payload ? payload.threads : [],
    ghBind: "ghBind" in payload ? payload.ghBind : null,
    shepherdStatus: "shepherdStatus" in payload ? payload.shepherdStatus : null,
    progress: "progress" in payload ? payload.progress : null,
    ciPlan: "ciPlan" in payload ? payload.ciPlan : null,
    ciChecks: "ciChecks" in payload ? payload.ciChecks : null,
    ciCwd: "ciCwd" in payload ? payload.ciCwd : null,
    searchQuery: "searchQuery" in payload ? payload.searchQuery : "",
    prs: payload.prs,
  });
}

function csp(webview: vscode.Webview, nonce: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />`;
}

function sharedCss(): string {
  return `
    :root {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    html, body { height: 100%; }
    body { margin: 0; }
    .muted { color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); padding: 8px 12px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    button:disabled { opacity: 0.55; cursor: default; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.cta {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      padding: 5px 12px;
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, transparent);
    }
    button.danger {
      background: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent));
      color: var(--vscode-errorForeground);
      outline: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    }
    button.success {
      background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 22%, transparent);
      color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #2ea043));
      outline: 1px solid var(--vscode-charts-green, #2ea043);
    }
    button.resolve-btn {
      background: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder)) 16%, transparent);
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      outline: 1px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground));
    }
    button.needs-action {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-charts-orange, #e2b203)) 18%, transparent);
      color: var(--vscode-editorWarning-foreground, var(--vscode-charts-orange, #e2b203));
      outline: 1px solid var(--vscode-editorWarning-foreground, var(--vscode-charts-orange, #e2b203));
    }
    .role.open {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #e2b203) 22%, var(--vscode-badge-background));
    }
    .role.addressed {
      background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 22%, var(--vscode-badge-background));
    }
    .role.resolved {
      background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 18%, var(--vscode-badge-background));
    }
    .ci-card {
      margin: 6px 0;
      padding: 8px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
      font-size: 11px;
    }
    .ci-card-why { color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .ci-checks { list-style: none; margin: 0; padding: 0; }
    .ci-check {
      display: flex; gap: 8px; align-items: baseline;
      padding: 3px 0; cursor: pointer; background: none; border: none;
      color: inherit; width: 100%; text-align: left; font: inherit;
    }
    .ci-check:hover { background: var(--vscode-list-hoverBackground); }
    .ci-check .name { text-decoration: underline; text-underline-offset: 2px; }
    .ci-check.pass .name { color: var(--vscode-charts-green, #2ea043); }
    .ci-check.fail .name { color: var(--vscode-errorForeground); }
    .ci-check.running .name, .ci-check.start .name { color: var(--vscode-editorWarning-foreground, #e2b203); }
    .ci-check .st { text-transform: uppercase; letter-spacing: 0.04em; font-size: 9px; min-width: 52px; }
    .ci-modal {
      position: fixed; inset: 0; z-index: 20;
      display: flex; align-items: center; justify-content: center;
    }
    .ci-modal[hidden] { display: none; }
    .ci-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); }
    .ci-modal-card {
      position: relative;
      width: min(520px, calc(100% - 24px));
      max-height: min(70vh, 480px);
      overflow: auto;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      padding: 12px;
    }
    .ci-modal-card header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .ci-modal-card h2 { margin: 0; font-size: 13px; flex: 1; }
    .ci-modal-body { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .ci-empty { color: var(--vscode-descriptionForeground); }
    .status {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .status.push-to-origin {
      color: var(--vscode-editorWarning-foreground, #e2b203);
      font-weight: 700;
    }
    .status.blocked {
      color: var(--vscode-charts-orange, #f59f00);
      font-weight: 600;
    }
    .status.running { color: var(--vscode-foreground); font-weight: 600; }
    @keyframes prgenie-spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 10px; height: 10px; box-sizing: border-box;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      border-radius: 50%;
      animation: prgenie-spin 0.8s linear infinite;
      flex: none;
    }
    .run-progress, .shepherd-progress {
      display: flex; align-items: center; gap: 8px; font-size: 11px;
    }
    .shepherd-progress { padding-left: 0; }
    .run-progress .step, .shepherd-progress .step {
      flex: 1; min-width: 0;
      white-space: normal; overflow-wrap: break-word; word-break: normal;
    }
  `;
}

function ciModalHtml(): string {
  return `<div id="ciModal" class="ci-modal" hidden role="dialog" aria-modal="true" aria-labelledby="ciModalTitle">
      <div class="ci-modal-backdrop" id="ciModalBackdrop"></div>
      <div class="ci-modal-card">
        <header>
          <h2 id="ciModalTitle">CI check</h2>
          <button type="button" class="secondary" id="ciModalClose">Close</button>
        </header>
        <div id="ciModalBody" class="ci-modal-body"></div>
      </div>
    </div>`;
}

function ciUiScript(): string {
  return `
    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function formatElapsed(ms) {
      if (ms < 1000) return Math.round(ms) + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }
    function bindCiModal() {
      // Query fresh #ciModal nodes on every open/close. Selecting another loop
      // rebuilds root.innerHTML (new dialog); capturing the first node once
      // left clicks/Esc writing to a detached element (RAD-77 AC3).
      const close = () => {
        const modal = document.getElementById("ciModal");
        if (modal) modal.hidden = true;
      };
      const open = (detail) => {
        const modal = document.getElementById("ciModal");
        const title = document.getElementById("ciModalTitle");
        const body = document.getElementById("ciModalBody");
        if (!modal || !title || !body) return;
        const name = detail.check || "CI check";
        const state = detail.state || "unknown";
        title.textContent = name + " — " + state;
        const parts = [];
        if (detail.reason) parts.push("Why selected: " + detail.reason);
        if (detail.elapsedMs != null) parts.push("Elapsed: " + formatElapsed(detail.elapsedMs));
        if (detail.excerpt) parts.push("Excerpt:\\n" + detail.excerpt);
        if (detail.log) parts.push("Log:\\n" + detail.log);
        if (detail.logPath && !detail.log) parts.push("Log path: " + detail.logPath);
        if (!parts.length) {
          if (state === "start" || state === "running" || state === "queued") {
            body.innerHTML = '<p class="ci-empty">Still running — no log yet. Wait for a pass/fail, or cancel from the panel.</p>';
          } else {
            body.innerHTML = '<p class="ci-empty">No excerpt or log for this check. Cached or skipped runs have no failure output.</p>';
          }
        } else {
          body.textContent = parts.join("\\n\\n");
        }
        modal.hidden = false;
      };
      document.addEventListener("click", (e) => {
        const el = e.target && e.target.closest ? e.target.closest("#ciModalClose, #ciModalBackdrop") : null;
        if (el) close();
      });
      document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("ciModal");
        if (e.key === "Escape" && modal && !modal.hidden) close();
      });
      window.addEventListener("message", (event) => {
        if (event.data && event.data.type === "ciDetail") open(event.data);
      });
      return { open, close };
    }
    function renderCiCard(host, progress, plan, stored, storedCwd) {
      if (!host) return;
      const planReason = plan && plan.reason
        ? (Array.isArray(plan.reason) ? plan.reason.join("; ") : plan.reason)
        : "";
      const reason = (progress && progress.selectionReason) || planReason || "";
      const cwdLine = (progress && progress.cwd) || storedCwd || "";
      const live = (progress && progress.checks) || [];
      const names = (live.length ? live.map((c) => c.name) : null)
        || (plan && plan.checks)
        || (stored && stored.map((c) => c.name))
        || [];
      if (!names.length && !reason && !cwdLine && !(progress && (progress.state === "start" || progress.phase === "ci"))) {
        host.hidden = true;
        host.innerHTML = "";
        return;
      }
      host.hidden = false;
      const rows = names.length ? names : ["(waiting)"];
      const byName = {};
      for (const row of live) byName[row.name] = row;
      for (const row of stored || []) {
        if (!byName[row.name]) byName[row.name] = {
          name: row.name,
          state: row.skipped ? "skip" : (row.passed ? "pass" : "fail"),
          elapsedMs: row.elapsedMs,
          message: row.excerpt,
          logPath: row.logPath,
          reason: row.reason,
        };
      }
      let html = '<div class="ci-card-why">' + escapeHtml(reason || "CI checks") + "</div>";
      if (cwdLine) {
        html += '<div class="ci-card-cwd muted">Cwd: ' + escapeHtml(cwdLine) + "</div>";
      }
      html += "<ul class='ci-checks'>";      for (const name of rows) {
        const row = byName[name] || { name, state: progress && !progress.cancelled ? "queued" : "unknown" };
        const st = row.state || "queued";
        const elapsed = row.elapsedMs != null ? " · " + formatElapsed(row.elapsedMs) : "";
        html += '<li><button type="button" class="ci-check ' + escapeHtml(st) + '" data-check="' + escapeHtml(name) + '" data-state="' + escapeHtml(st) + '" data-excerpt="' + escapeHtml(row.message || "") + '" data-log="' + escapeHtml(row.logPath || "") + '" data-elapsed="' + (row.elapsedMs != null ? row.elapsedMs : "") + '" data-reason="' + escapeHtml(row.reason || reason || "") + '"><span class="st">' + escapeHtml(st) + '</span><span class="name">' + escapeHtml(name) + "</span><span class='muted'>" + elapsed + "</span></button></li>";
      }
      html += "</ul>";
      host.innerHTML = html;
      for (const btn of host.querySelectorAll(".ci-check[data-check]")) {
        btn.onclick = () => vscode.postMessage({
          type: "openCiDetail",
          check: btn.getAttribute("data-check"),
          state: btn.getAttribute("data-state"),
          excerpt: btn.getAttribute("data-excerpt"),
          logPath: btn.getAttribute("data-log") || undefined,
          elapsedMs: btn.getAttribute("data-elapsed") ? Number(btn.getAttribute("data-elapsed")) : undefined,
          reason: btn.getAttribute("data-reason") || undefined,
        });
      }
    }
  `;
}

function laneHtml(webview: vscode.Webview): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp(webview, nonce)}
  <style>
    ${sharedCss()}
    body { padding: 4px 0 8px; }
    .meta {
      display: flex; flex-direction: column; gap: 6px;
      padding: 4px 12px 8px;
      font-size: 11px;
    }
    .meta-top { display: flex; align-items: center; gap: 6px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); flex: none; }
    .dot.off { background: var(--vscode-descriptionForeground); }
    .gh-bind {
      display: flex; flex-direction: column; gap: 4px;
      padding: 6px 8px; margin-top: 4px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
    }
    .gh-bind-row {
      display: flex; align-items: center; gap: 8px; font-size: 11px;
    }
    .gh-bind-row .label {
      width: 42px; flex: none; text-transform: uppercase; letter-spacing: 0.04em;
      font-size: 10px; color: var(--vscode-descriptionForeground);
    }
    .gh-bind-row .value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .gh-bind-row button { flex: none; font-size: 11px; padding: 2px 6px; }
    .gh-bind-row select {
      flex: 1; min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 2px 4px;
      font-size: 11px;
    }
    .gh-bind-warning {
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #f59f004d) 50%, transparent);
      padding: 4px 6px;
      font-size: 10px;
      border-left: 2px solid var(--vscode-inputValidation-warningBorder, var(--vscode-charts-yellow, #f59f00));
    }
    .shepherd {
      display: flex; flex-direction: column; gap: 4px;
      padding: 6px 8px; margin-top: 4px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
      min-width: 0;
    }
    .shepherd-header {
      display: flex; flex-direction: column; align-items: stretch; gap: 4px; font-size: 11px;
      min-width: 0;
    }
    .shepherd-header .label {
      display: block; width: auto; flex: none;
      text-transform: uppercase; letter-spacing: 0.04em;
      font-size: 10px; color: var(--vscode-descriptionForeground);
    }
    .shepherd-header-row {
      display: flex; align-items: center; gap: 8px; min-width: 0;
    }
    .shepherd-header .status {
      flex: 1; min-width: 0; font-weight: 600;
      white-space: normal; overflow-wrap: break-word; word-break: normal;
    }
    .shepherd-header .status.ready { color: var(--vscode-charts-green, #3fb950); }
    .shepherd-header .status.blocked { color: var(--vscode-charts-orange, #f59f00); }
    .shepherd-header .status.running { color: var(--vscode-foreground); }
    .shepherd-reasons {
      display: flex; flex-direction: column; gap: 2px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      min-width: 0;
    }
    .shepherd-empty {
      margin: 0; font-size: 10px;
      color: var(--vscode-descriptionForeground);
      min-width: 0; max-width: 100%;
      white-space: normal; overflow-wrap: break-word; word-break: normal;
    }
    .shepherd-header .status.quiet {
      font-weight: 500; text-transform: none; letter-spacing: normal;
      color: var(--vscode-descriptionForeground);
    }
    /* Column layout + no width:100% on the check button — row + .ci-check{width:100%}
       squeezed .message to ~1ch and overflow-wrap:anywhere stacked one char per line. */
    .shepherd-reason {
      display: flex; flex-direction: column; gap: 2px; min-width: 0;
    }
    .shepherd-reason .ci-check {
      width: auto; max-width: 100%; flex: none;
    }
    .shepherd-reason .check {
      flex: none; text-transform: uppercase; letter-spacing: 0.04em;
      font-weight: 600;
    }
    .shepherd-reason .message {
      min-width: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
    }
    .pr {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    .pr .info { flex: 1; min-width: 0; }
    .pr .acts { display: flex; flex-direction: column; gap: 4px; flex: none; margin-top: 2px; }
    .pr .go, .pr .rename { flex: none; font-size: 11px; padding: 2px 6px; }
    .pr:hover { background: var(--vscode-list-hoverBackground); }
    .pr.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }
    .pr.here { border-left-color: var(--vscode-charts-green, #3fb950); }
    .pr.fresh { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
    .pr.exporting {
      border-left-width: 3px;
      border-left-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
    }
    .pr.push-to-origin {
      border-left-width: 3px;
      border-left-color: var(--vscode-editorWarning-foreground, #e2b203);
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #e2b203) 14%, transparent);
    }
    .pr.export-blocked { border-left-color: var(--vscode-charts-orange, #f59f00); }
    .pr.archived { opacity: 0.72; }
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; }
    .search-box {
      display: flex; align-items: center; gap: 4px;
      padding: 0 0 6px 0;
    }
    .search-box input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 4px 8px;
      font-size: 12px;
      outline: none;
    }
    .search-box input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-box input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .search-box button {
      padding: 4px 8px;
      font-size: 11px;
    }
    .meta-top button { margin-left: auto; font-size: 11px; }
    .meta-top button.on { outline: 1px solid var(--vscode-focusBorder); }
  </style>
</head>
<body>
  <div class="meta">
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search loops (title, body, comments, files)" />
      <button type="button" class="secondary" id="clearSearch" title="Clear search">✕</button>
    </div>
    <div class="gh-bind" id="ghBind" hidden>
      <div class="gh-bind-row">
        <span class="label">gh bind</span>
        <span class="value muted" id="ghBindStatus">—</span>
        <button type="button" class="secondary" id="ghRefreshBtn">Refresh</button>
      </div>
      <div class="gh-bind-row" id="ghBindControls" hidden>
        <span class="label"></span>
        <select id="ghAccountSelect"></select>
        <button type="button" class="secondary" id="ghBindBtn">Bind</button>
      </div>
      <div class="gh-bind-warning" id="ghBindWarning" hidden></div>
    </div>
    <div class="shepherd" id="shepherd" hidden>
      <div class="shepherd-header">
        <span class="label">${STATUS_PANEL_TITLE}</span>
        <div class="shepherd-header-row">
          <span class="status" id="shepherdStatus">—</span>
          <button type="button" class="secondary" id="cancelProgress" hidden>Cancel</button>
          <button type="button" class="secondary" id="retryProgress" hidden>Retry CI</button>
        </div>
      </div>
      <div class="shepherd-progress" id="shepherdProgress" hidden>
        <span class="spinner" id="shepherdSpinner"></span>
        <span class="step" id="shepherdStep"></span>
      </div>
      <p class="shepherd-empty" id="shepherdEmpty" hidden></p>
      <div class="shepherd-reasons" id="shepherdReasons"></div>
      <div class="ci-card" id="ciCard" hidden></div>
    </div>
    ${ciModalHtml()}
    <div class="meta-top"><span class="dot off" id="dot"></span><span class="muted" id="meta">Watching</span><button type="button" class="secondary" id="archivedToggle">Show archived</button></div>
  </div>
  <div id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${ciUiScript()}
    bindCiModal();
    const list = document.getElementById("list");
    const toggle = document.getElementById("archivedToggle");
    const searchInput = document.getElementById("searchInput");
    const clearSearch = document.getElementById("clearSearch");
    let searchDebounce = null;
    searchInput.oninput = () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        vscode.postMessage({ type: "search", query: searchInput.value });
      }, 300);
    };
    clearSearch.onclick = () => {
      searchInput.value = "";
      vscode.postMessage({ type: "search", query: "" });
    };
    toggle.onclick = () => vscode.postMessage({ type: "showArchived", value: !toggle.classList.contains("on") });
    const ghRefreshBtn = document.getElementById("ghRefreshBtn");
    const ghBindBtn = document.getElementById("ghBindBtn");
    const ghAccountSelect = document.getElementById("ghAccountSelect");
    let bindInProgress = false;
    let liveProgress = null;
    let lastSnapshot = {};
    const STATUS_IDLE = ${JSON.stringify({
      noLoops: statusPanelIdleBody({}),
      archived: statusPanelIdleBody({ archivedCount: 1 }),
      search: statusPanelIdleBody({ searchQuery: "q" }),
    })};
    const STATUS_PHASE = ${JSON.stringify({
      draft: statusPanelGuidanceForLoop("draft"),
      ready: statusPanelGuidanceForLoop("ready"),
      changes_requested: statusPanelGuidanceForLoop("changes_requested"),
      approved: statusPanelGuidanceForLoop("approved"),
    })};
    const cancelBtn = document.getElementById("cancelProgress");
    const retryBtn = document.getElementById("retryProgress");
    if (cancelBtn) cancelBtn.onclick = () => vscode.postMessage({ type: "cancelProgress" });
    if (retryBtn) retryBtn.onclick = () => {
      const id = (lastSnapshot.selectedId) || (liveProgress && liveProgress.id);
      if (id) vscode.postMessage({ type: "retryProgress", id });
    };
    if (ghRefreshBtn) {
      ghRefreshBtn.onclick = () => vscode.postMessage({ type: "ghRefresh" });
    }
    if (ghBindBtn && ghAccountSelect) {
      ghBindBtn.onclick = () => {
        if (bindInProgress) return;
        const login = ghAccountSelect.value;
        if (login) {
          bindInProgress = true;
          ghBindBtn.disabled = true;
          ghBindBtn.textContent = "Binding…";
          vscode.postMessage({ type: "ghBind", login });
        }
      };
    }
    function paintDot(msg) {
      const dot = document.getElementById("dot");
      if (dot) dot.classList.toggle("off", !!msg.error);
    }
    function paintGhBind(msg) {
      const ghBindBox = document.getElementById("ghBind");
      const ghBindStatus = document.getElementById("ghBindStatus");
      const ghBindControls = document.getElementById("ghBindControls");
      const ghBindWarning = document.getElementById("ghBindWarning");
      const ghAccountSelect = document.getElementById("ghAccountSelect");
      const ghBindBtn = document.getElementById("ghBindBtn");
      
      const hasGhBind = !!(msg.ghBind);
      if (ghBindBox) ghBindBox.hidden = !hasGhBind;
      if (!hasGhBind) return;

      const bind = msg.ghBind;
      const accounts = bind.accounts || [];
      const bound = bind.bound;
      const activeAccount = accounts.find(a => a.active);

      if (ghBindStatus) {
        if (bind.error) {
          ghBindStatus.textContent = "error: " + bind.error;
          ghBindStatus.className = "value";
        } else if (!accounts.length) {
          ghBindStatus.textContent = "no gh accounts (run: gh auth login)";
          ghBindStatus.className = "value";
        } else if (bound) {
          const isBoundActive = activeAccount && activeAccount.login === bound.login;
          ghBindStatus.textContent = bound.login + (isBoundActive ? " (active)" : " (not active)");
          ghBindStatus.className = "value";
        } else {
          ghBindStatus.textContent = "unbound (export will fail)";
          ghBindStatus.className = "value";
        }
      }

      if (ghBindControls && ghAccountSelect && ghBindBtn) {
        if (bind.error || accounts.length === 0) {
          ghBindControls.hidden = true;
        } else {
          ghBindControls.hidden = false;
          ghAccountSelect.textContent = '';
          for (const account of accounts) {
            const option = document.createElement('option');
            option.value = account.login;
            option.textContent = account.login + (account.active ? ' (active)' : '');
            ghAccountSelect.appendChild(option);
          }
          if (bound) {
            ghAccountSelect.value = bound.login;
          }
          ghBindBtn.disabled = false;
        }
      }

      if (ghBindWarning) {
        if (!bind.error && accounts.length > 0 && !bound) {
          ghBindWarning.textContent = "⚠ This repo is unbound. Export can fail on the wrong GitHub account. Select an account and click Bind.";
          ghBindWarning.hidden = false;
        } else if (!bind.error && bound && activeAccount && activeAccount.login !== bound.login) {
          ghBindWarning.textContent = "⚠ Active gh account (" + activeAccount.login + ") does not match bound account (" + bound.login + "). Export will switch accounts.";
          ghBindWarning.hidden = false;
        } else {
          ghBindWarning.hidden = true;
        }
      }
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch]);
    }
    function paintShepherd(msg) {
      const shepherdBox = document.getElementById("shepherd");
      const shepherdStatus = document.getElementById("shepherdStatus");
      const shepherdReasons = document.getElementById("shepherdReasons");
      const shepherdEmpty = document.getElementById("shepherdEmpty");
      const progressBox = document.getElementById("shepherdProgress");
      const stepEl = document.getElementById("shepherdStep");
      const spinner = document.getElementById("shepherdSpinner");
      const cancel = document.getElementById("cancelProgress");
      const retry = document.getElementById("retryProgress");
      
      if (!shepherdBox || !shepherdStatus || !shepherdReasons) return;

      const prs = msg.prs || [];
      const selected = prs.find((p) => p.id === msg.selectedId) || null;
      const progress = liveProgress && (!selected || liveProgress.id === selected.id)
        ? liveProgress
        : null;

      const clearExportExtras = () => {
        shepherdReasons.innerHTML = '';
        if (shepherdEmpty) {
          shepherdEmpty.hidden = true;
          shepherdEmpty.textContent = '';
        }
        if (progressBox) progressBox.hidden = true;
        if (cancel) cancel.hidden = true;
        if (retry) retry.hidden = true;
        renderCiCard(document.getElementById("ciCard"), null, null, null, null);
      };

      const showQuiet = (statusLabel, emptyText) => {
        shepherdBox.hidden = false;
        shepherdStatus.textContent = statusLabel;
        shepherdStatus.className = "status quiet";
        clearExportExtras();
        if (shepherdEmpty) {
          shepherdEmpty.hidden = false;
          shepherdEmpty.textContent = emptyText;
        }
      };

      // 0 loops / no selection — idle STATUS, never a prior loop's READY/FAIL list (RAD-110).
      if (!prs.length) {
        const archived = msg.archivedCount || 0;
        let emptyText;
        if (msg.searchQuery && msg.searchQuery.trim()) {
          emptyText = STATUS_IDLE.search;
        } else if (archived) {
          emptyText = STATUS_IDLE.archived;
        } else {
          emptyText = STATUS_IDLE.noLoops;
        }
        showQuiet("IDLE", emptyText);
        return;
      }

      if (!selected) {
        showQuiet("—", "Select a live loop to see draft, review, CI, or export status.");
        return;
      }

      // Pre-review / archived: phase-correct STATUS, never EXPORT BLOCKED + FAIL lists.
      if (selected && selected.status !== "reviewed" && !progress) {
        if (selected.status === "approved") {
          showQuiet(STATUS_PHASE.approved.badge, STATUS_PHASE.approved.body);
          return;
        }
        const phase = STATUS_PHASE[selected.status] || {
          badge: (selected.status || "—").replace("_", " ").toUpperCase(),
          body: "Implement or review this loop — STATUS is not an export gate yet.",
        };
        showQuiet(phase.badge, phase.body);
        return;
      }

      const shepherd = msg.shepherdStatus;
      if (!shepherd && !progress) {
        if (selected && selected.status === "reviewed") {
          const hint = (selected.humanExport && selected.humanExport.hint)
            || "Review is done. Shepherd CI must pass before Open on GitHub is available.";
          const badge = selected.humanExport && selected.humanExport.kind === "pending" ? "PENDING" : "—";
          showQuiet(badge, hint);
          return;
        }
        shepherdBox.hidden = true;
        clearExportExtras();
        return;
      }
      
      shepherdBox.hidden = false;
      if (shepherdEmpty) {
        shepherdEmpty.hidden = true;
        shepherdEmpty.textContent = '';
      }
      if (progress && progress.cancelled) {
        shepherdStatus.textContent = "cancelled";
        shepherdStatus.className = "status blocked";
      } else if (progress && (progress.state === "start" || progress.state === "cached" || progress.state === "pass")) {
        shepherdStatus.textContent = "running";
        shepherdStatus.className = "status running";
      } else if (shepherd) {
        shepherdStatus.textContent = shepherd.status;
        shepherdStatus.className = "status " + shepherd.status;
      } else {
        shepherdStatus.textContent = "running";
        shepherdStatus.className = "status running";
      }
      
      if (progressBox && stepEl) {
        if (progress) {
          progressBox.hidden = false;
          const extra = progress.failed
            ? [progress.command, progress.message].filter(Boolean).length
              ? " — " + [progress.command, progress.message].filter(Boolean).join(" — ")
              : ""
            : "";
          stepEl.textContent = (progress.step || "CI checks") + extra;
          if (spinner) spinner.hidden = !!progress.cancelled;
        } else {
          progressBox.hidden = true;
        }
      }
      if (cancel) {
        cancel.hidden = !(progress && progress.cancellable && !progress.cancelled);
      }
      if (retry) {
        retry.hidden = !(progress && progress.cancelled);
      }
      
      shepherdReasons.innerHTML = '';
      if (shepherd && shepherd.reasons && shepherd.reasons.length > 0 && !(progress && !progress.cancelled && !progress.failed)) {
        for (const reason of shepherd.reasons) {
          const reasonEl = document.createElement('div');
          reasonEl.className = 'shepherd-reason';
          const checkName = (reason.message || "").match(/CI check failed:\\s+([^\\s—]+)/);
          const label = checkName ? checkName[1] : reason.check;
          reasonEl.innerHTML = '<button type="button" class="ci-check ' + (reason.check === "ci" ? "fail" : "") + '" data-check="' + escapeHtml(label) + '" data-state="fail" data-excerpt="' + escapeHtml(reason.message) + '"><span class="check">' + escapeHtml(label) + '</span></button><span class="message">' + escapeHtml(reason.message) + '</span>';
          shepherdReasons.appendChild(reasonEl);
          const btn = reasonEl.querySelector(".ci-check");
          if (btn) {
            btn.onclick = () => vscode.postMessage({
              type: "openCiDetail",
              check: btn.getAttribute("data-check"),
              state: "fail",
              excerpt: reason.message,
            });
          }
        }
      }
      renderCiCard(document.getElementById("ciCard"), progress, msg.ciPlan, msg.ciChecks, msg.ciCwd);
    }
    function prRow(id) {
      const el = document.createElement("div");
      el.dataset.id = id;
      el.innerHTML = '<div class="info"><div class="status"></div><div class="title"></div><div class="muted"></div></div><div class="acts"><button type="button" class="rename secondary">Rename</button><button type="button" class="go secondary"></button></div>';
      el.querySelector(".go").onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openFolder", id: el.dataset.id });
      };
      el.querySelector(".rename").onclick = (e) => {
        e.stopPropagation();
        if (el.querySelector(".rename").disabled) return;
        vscode.postMessage({ type: "renamePr", id: el.dataset.id });
      };
      el.onclick = () => vscode.postMessage({ type: "select", id: el.dataset.id });
      return el;
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "progress") {
        liveProgress = msg.progress || null;
        // Keep lastSnapshot.progress in sync so replaying the list does not wipe the live step (RAD-124).
        lastSnapshot = Object.assign({}, lastSnapshot, { progress: liveProgress });
        paintShepherd(lastSnapshot);
        if (lastSnapshot.prs) {
          window.dispatchEvent(new MessageEvent("message", { data: Object.assign({}, lastSnapshot, { type: "snapshot" }) }));
        }
        return;
      }
      if (msg.type !== "snapshot") return;
      lastSnapshot = msg;
      if (Object.prototype.hasOwnProperty.call(msg, "progress")) {
        const incoming = msg.progress || null;
        // Snapshot refresh must not overwrite live export/gate progress with empty progress.
        if (
          !incoming &&
          liveProgress &&
          !liveProgress.cancelled &&
          (liveProgress.kind === "export" || liveProgress.kind === "gate")
        ) {
          lastSnapshot = Object.assign({}, msg, { progress: liveProgress });
        } else {
          liveProgress = incoming;
        }
      }
      const meta = document.getElementById("meta");
      paintDot(msg);
      paintGhBind(msg);
      paintShepherd(lastSnapshot);
      if (msg.searchQuery !== undefined && searchInput.value !== msg.searchQuery) {
        searchInput.value = msg.searchQuery;
      }
      if (bindInProgress) {
        bindInProgress = false;
        const ghBindBtn = document.getElementById("ghBindBtn");
        if (ghBindBtn) {
          ghBindBtn.disabled = false;
          ghBindBtn.textContent = "Bind";
        }
      }
      if (msg.error) {
        meta.textContent = "Watching";
        toggle.hidden = true;
        list.innerHTML = '<p class="error"></p>';
        list.firstChild.textContent = msg.error;
        return;
      }
      const prs = msg.prs || [];
      const fresh = new Set(msg.freshIds || []);
      const archived = msg.archivedCount || 0;
      toggle.classList.toggle("on", !!msg.showArchived);
      toggle.textContent = msg.showArchived ? "Hide archived" : "Show archived";
      toggle.hidden = !(archived || msg.showArchived);
      meta.textContent = (msg.repo ? msg.repo + " · " : "") + prs.length + " loop" + (prs.length === 1 ? "" : "s")
        + (archived ? " · " + archived + " archived" : "");
      if (!prs.length) {
        let emptyText;
        if (msg.searchQuery && msg.searchQuery.trim()) {
          emptyText = "No loops match your search. Clear the search to view all loops.";
        } else if (archived) {
          emptyText = "No active loops. " + archived + " archived after export. Show archived to view them.";
        } else {
          emptyText = "Waiting for agents. Loops land here when work is committed.";
        }
        if (list.dataset.empty !== emptyText) {
          list.innerHTML = '<p class="muted empty"></p>';
          list.firstChild.textContent = emptyText;
          list.dataset.empty = emptyText;
        }
        return;
      }
      delete list.dataset.empty;
      for (const leftover of [...list.querySelectorAll(":scope > .empty")]) leftover.remove();
      const y = list.scrollTop;
      const nodes = new Map();
      for (const el of list.querySelectorAll(".pr")) nodes.set(el.dataset.id, el);
      const used = new Set();
      for (const pr of prs) {
        used.add(pr.id);
        let el = nodes.get(pr.id);
        if (!el) {
          el = prRow(pr.id);
          nodes.set(pr.id, el);
          list.appendChild(el);
        }
        const here = pr.id === msg.hereId;
        const archivedPr = pr.status === "approved";
        const exportUi = pr.humanExport || {};
        const yourTurn = !!exportUi.yourTurn;
        const exportBlocked = exportUi.kind === "blocked";
        const rowProgress = liveProgress && liveProgress.id === pr.id ? liveProgress : null;
        const exporting = !!(rowProgress && !rowProgress.cancelled);
        el.className = "pr"
          + (pr.id === msg.selectedId ? " active" : "")
          + (fresh.has(pr.id) ? " fresh" : "")
          + (here ? " here" : "")
          + (archivedPr ? " archived" : "")
          + (exporting ? " exporting" : "")
          + (yourTurn && !exporting ? " push-to-origin" : "")
          + (exportBlocked ? " export-blocked" : "");
        const src = pr.source && pr.source.kind === "subagent"
          ? (pr.source.subagentType || "subagent")
          : (pr.source && pr.source.kind) || "local";
        const info = el.querySelector(".info");
        const statusEl = info.children[0];
        statusEl.className = "status"
          + (yourTurn && !exporting ? " push-to-origin" : "")
          + (exportBlocked ? " blocked" : "")
          + (exporting ? " running" : "");
        statusEl.textContent = archivedPr
          ? "archived"
          : rowProgress
            ? (rowProgress.cancelled ? "cancelled" : rowProgress.step)
          : exportUi.listStatus
            ? exportUi.listStatus
            : pr.status.replace("_", " ");
        info.children[1].textContent = pr.title;
        info.children[1].title = pr.title;
        info.children[2].textContent = src + " · " + pr.headRef + " → " + pr.baseRef;
        const go = el.querySelector(".go");
        go.textContent = archivedPr ? "Archived" : here ? "Here" : "Switch";
        go.disabled = archivedPr || here;
        const rename = el.querySelector(".rename");
        const saving = msg.titleSaveInFlightId === pr.id;
        rename.hidden = archivedPr;
        rename.disabled = archivedPr || saving;
        rename.textContent = saving ? "Saving…" : "Rename";
      }
      for (const [id, el] of nodes) if (!used.has(id)) el.remove();
      for (let i = 0; i < prs.length; i++) {
        const el = nodes.get(prs[i].id);
        if (el && list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
      }
      list.scrollTop = y;
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function panelHtml(webview: vscode.Webview): string {
  const nonce = String(Date.now() + 1);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp(webview, nonce)}
  <style>
    ${sharedCss()}
    body { display: flex; flex-direction: column; }
    #root { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }
    .toolbar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .toolbar h1 {
      font-size: 13px; font-weight: 600; margin: 0;
      white-space: normal;
      overflow: visible;
      flex: 1 1 180px;
      min-width: 0;
    }
    .pill {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .pill.push-to-origin {
      background: var(--vscode-editorWarning-foreground, #e2b203);
      color: var(--vscode-editor-background, #1e1e1e);
      font-weight: 700;
      box-shadow: 0 0 0 1px var(--vscode-editorWarning-border, #e2b203);
    }
    .pill.blocked {
      background: color-mix(in srgb, var(--vscode-charts-orange, #f59f00) 28%, var(--vscode-badge-background));
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .actions {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      width: 100%;
      flex: 1 1 100%;
    }
    .actions .spacer { flex: 1; min-width: 8px; }
    .grow { flex: 1; }
    .body { display: flex; flex: 1; min-height: 0; }
    .files {
      flex: 1; min-width: 0; min-height: 0; overflow: hidden;
      display: flex; flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .files h2, .comments h2, .summary h2 {
      font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
      margin: 0; padding: 8px 10px; color: var(--vscode-descriptionForeground); flex: none;
    }
    .summary {
      flex: none; max-height: 30%; overflow: auto;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .summary .pad { padding: 0 10px 8px; }
    .file {
      display: flex; gap: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px;
    }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file .st { width: 16px; flex: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .mod { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); }
    .comments {
      width: 280px; flex: none; min-height: 0; overflow: hidden;
      display: flex; flex-direction: column;
    }
    #flist, #clist { flex: 1; min-height: 0; overflow: auto; }
    #clist { padding: 0 10px 8px; }
    .thread {
      margin: 8px 0 0;
      padding: 8px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
    }
    .thread.resolved { opacity: 0.72; }
    .thread .body { font-size: 12px; white-space: pre-wrap; }
    .replies {
      margin: 8px 0 0;
      padding: 8px 0 0 10px;
      border-left: 2px solid var(--vscode-focusBorder, var(--vscode-widget-border, #0078d4));
    }
    .reply { font-size: 12px; margin-top: 8px; }
    .reply:first-child { margin-top: 0; }
    .reply .body { white-space: pre-wrap; }
    .comment .who, .thread .who, .reply .who {
      font-size: 11px; margin-bottom: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    }
    .loc { font-size: 11px; padding: 1px 6px; }
    .role {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 5px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .hint { font-size: 11px; margin: 0 0 8px; }
    textarea {
      width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); padding: 6px;
    }
    .composer { padding: 8px 10px; flex: none; }
    .empty { padding: 16px 12px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${ciUiScript()}
    const root = document.getElementById("root");
    bindCiModal();
    const COMPOSER_HINT = ${JSON.stringify(HUMAN_EXPORT_COMPOSER_HINT)};
    const EXPORT_PRIMARY = ${JSON.stringify(HUMAN_EXPORT_PRIMARY_ACTION)};
    // Injected from statusPanel.exportBusyHelper (single source of truth — RAD-124).
    const EXPORT_BUSY_TEMPLATE = ${JSON.stringify(exportBusyHelper("{{STEP}}"))};
    function exportBusyHintFor(step) {
      const label = (step && String(step).trim()) || "export in progress";
      return EXPORT_BUSY_TEMPLATE.split("{{STEP}}").join(label);
    }
    let layoutId = null;
    let serverSum = "";
    let paintedFiles = "";
    let paintedComments = "";
    let liveProgress = null;
    let lastSelected = null;
    let lastMsg = null;
    function esc(s) {
      return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    }
    function stLabel(s) {
      const ch = (s || "?")[0];
      if (ch === "A") return { t: "A", c: "add" };
      if (ch === "D") return { t: "D", c: "del" };
      if (ch === "M") return { t: "M", c: "mod" };
      if (ch === "R") return { t: "R", c: "mod" };
      return { t: ch, c: "" };
    }
    function fileLabel(p) {
      const parts = String(p || "").split("\\t");
      return parts[parts.length - 1] || p;
    }
    function roleLabel(role) {
      if (role === "agent") return "Agent";
      if (role === "reviewer") return "Reviewer";
      return "Human";
    }
    function bindChrome(selected, msg) {
      root.querySelector("#saveSum").onclick = () => vscode.postMessage({
        type: "summary",
        id: selected.id,
        body: root.querySelector("#sum").value
      });
      for (const btn of root.querySelectorAll("button[data-s]")) {
        btn.onclick = () => vscode.postMessage({ type: "status", id: selected.id, status: btn.getAttribute("data-s") });
      }
      root.querySelector("#openWt").onclick = () => vscode.postMessage({ type: "openFolder", id: selected.id });
      const openTerm = root.querySelector("#openTerminal");
      if (openTerm) openTerm.onclick = () => vscode.postMessage({ type: "openTerminal", id: selected.id });
      root.querySelector("#copyReview").onclick = () => vscode.postMessage({ type: "copyReviewPrompt", id: selected.id });
      root.querySelector("#openDiffs").onclick = () => vscode.postMessage({ type: "openDiffs" });
      const exp = root.querySelector("#exportPr");
      if (exp) exp.onclick = () => vscode.postMessage({ type: "export", id: selected.id });
      const cancel = root.querySelector("#cancelProgress");
      if (cancel) cancel.onclick = () => vscode.postMessage({ type: "cancelProgress" });
      const retry = root.querySelector("#retryProgress");
      if (retry) retry.onclick = () => vscode.postMessage({ type: "retryProgress", id: selected.id });
      const complete = root.querySelector("#completeReview");
      if (complete) complete.onclick = () => vscode.postMessage({ type: "completeReview", id: selected.id });
      const del = root.querySelector("#deletePr");
      if (del) del.onclick = () => vscode.postMessage({ type: "deletePr", id: selected.id });
      const reopen = root.querySelector("#reopenPr");
      if (reopen) reopen.onclick = () => vscode.postMessage({ type: "reopenPr", id: selected.id });
      const rename = root.querySelector("#renamePr");
      if (rename) rename.onclick = () => {
        if (rename.disabled) return;
        vscode.postMessage({ type: "renamePr", id: selected.id });
      };
      root.querySelector("#send").onclick = () => {
        const body = root.querySelector("#cmt").value;
        if (body.trim()) vscode.postMessage({ type: "comment", id: selected.id, body });
      };
    }
    function bindFiles() {
      for (const el of root.querySelectorAll(".file[data-path]")) {
        el.onclick = () => vscode.postMessage({
          type: "openFile",
          path: el.getAttribute("data-path"),
          status: el.getAttribute("data-status") || "M"
        });
      }
    }
    function bindComments(selected) {
      for (const el of root.querySelectorAll(".address[data-cid]")) {
        el.onclick = () => vscode.postMessage({
          type: "address",
          id: selected.id,
          commentId: el.getAttribute("data-cid")
        });
      }
      for (const el of root.querySelectorAll(".resolve[data-cid]")) {
        el.onclick = () => vscode.postMessage({
          type: "resolve",
          id: selected.id,
          commentId: el.getAttribute("data-cid")
        });
      }
      for (const el of root.querySelectorAll(".edit[data-cid]")) {
        el.onclick = () => vscode.postMessage({
          type: "editComment",
          id: selected.id,
          commentId: el.getAttribute("data-cid")
        });
      }
      for (const el of root.querySelectorAll(".delete-c[data-cid]")) {
        el.onclick = () => vscode.postMessage({
          type: "deleteComment",
          id: selected.id,
          commentId: el.getAttribute("data-cid")
        });
      }
      for (const el of root.querySelectorAll(".loc[data-path]")) {
        el.onclick = () => vscode.postMessage({
          type: "openComment",
          path: el.getAttribute("data-path"),
          line: Number(el.getAttribute("data-line") || 0) || undefined
        });
      }
    }
    function setTextarea(el, next) {
      if (!el || document.activeElement === el || el.value === next) return;
      el.value = next;
    }
    function paintChrome(selected, msg) {
      const short = (sha) => (sha || "").slice(0, 7);
      const when = selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : "";
      const archived = selected.status === "approved";
      const reviewed = selected.status === "reviewed";
      const ready = selected.status === "ready";
      const exportUi = selected.humanExport || {};
      const yourTurn = !!exportUi.yourTurn;
      const exportBlocked = exportUi.kind === "blocked";
      const progress = liveProgress && liveProgress.id === selected.id ? liveProgress : null;
      root.querySelector("h1").textContent = selected.title;
      root.querySelector("h1").title = selected.title;
      const pill = root.querySelector(".pill");
      pill.textContent = progress
        ? (progress.cancelled ? "cancelled" : progress.step)
        : exportUi.pillText || selected.status.replace("_", " ");
      pill.className = "pill" + (yourTurn && !progress ? " push-to-origin" : "") + (exportBlocked || (progress && progress.cancelled) ? " blocked" : "");
      root.querySelector("#range").textContent =
        selected.id + " · " + selected.headRef + " → " + selected.baseRef + " · " + short(selected.headSha) + " " + (when ? "· " + when : "");
      const filesH2 = root.querySelector(".files h2");
      if (filesH2) filesH2.textContent = "Changes (" + (selected.worktreePath ? "worktree" : "head") + ")";
      root.querySelector("#openWt").textContent = archived
        ? "Archived"
        : selected.id === msg.hereId ? "This window" : "Switch to this loop";
      root.querySelector("#openWt").disabled = archived || selected.id === msg.hereId;
      const copyReview = root.querySelector("#copyReview");
      if (copyReview) {
        copyReview.hidden = archived || reviewed;
        copyReview.disabled = archived;
      }
      const ship = root.querySelector("#exportPr");
      const busyHint = root.querySelector("#exportBusyHint");
      if (ship) {
        if (archived) {
          ship.hidden = true;
        } else if (exportUi.showExportPrimary) {
          ship.hidden = false;
          ship.disabled = false;
          ship.className = "cta";
          ship.textContent = EXPORT_PRIMARY;
        } else if (reviewed) {
          ship.hidden = true;
        } else if (ready) {
          ship.hidden = false;
          ship.disabled = false;
          ship.className = "secondary";
          ship.textContent = "Open on GitHub anyway";
        } else {
          ship.hidden = true;
        }
        if (progress && !progress.cancelled) {
          ship.disabled = true;
          const helper = exportBusyHintFor(progress.step);
          ship.title = helper;
          if (busyHint) {
            busyHint.hidden = false;
            busyHint.textContent = helper;
          }
        } else {
          ship.title = "";
          if (busyHint) {
            busyHint.hidden = true;
            busyHint.textContent = "";
          }
        }
      }
      const runBox = root.querySelector("#runProgress");
      const runStep = root.querySelector("#runStep");
      const runSpinner = root.querySelector("#runSpinner");
      const cancelRun = root.querySelector("#cancelProgress");
      const retryRun = root.querySelector("#retryProgress");
      if (runBox) {
        if (progress) {
          runBox.hidden = false;
          if (runStep) {
            const extra = progress.failed
              ? [progress.command, progress.message].filter(Boolean).length
                ? " — " + [progress.command, progress.message].filter(Boolean).join(" — ")
                : ""
              : "";
            runStep.textContent = (progress.step || "CI checks") + extra;
          }
          if (runSpinner) runSpinner.hidden = !!progress.cancelled;
          if (cancelRun) cancelRun.hidden = !(progress.cancellable && !progress.cancelled);
          if (retryRun) retryRun.hidden = !progress.cancelled;
        } else {
          runBox.hidden = true;
        }
      }
      renderCiCard(root.querySelector("#ciCard"), progress, msg.ciPlan, msg.ciChecks, msg.ciCwd);
      const openTermBtn = root.querySelector("#openTerminal");
      if (openTermBtn) {
        openTermBtn.disabled = archived || !selected.worktreePath;
        openTermBtn.title = selected.worktreePath ? "Open a terminal in this loop worktree" : "Worktree path missing";
      }
      const complete = root.querySelector("#completeReview");
      if (complete) {
        complete.hidden = !ready;
        complete.disabled = !ready;
        complete.className = ready ? "secondary" : "secondary";
      }
      const markReady = root.querySelector("#markReady");
      if (markReady) {
        markReady.hidden = archived || reviewed || ready;
        markReady.disabled = archived;
      }
      const requestChanges = root.querySelector("#requestChanges");
      if (requestChanges) {
        requestChanges.hidden = archived || reviewed;
        requestChanges.disabled = archived;
      }
      const archiveBtn = root.querySelector("#archivePr");
      if (archiveBtn) {
        archiveBtn.hidden = archived;
        archiveBtn.disabled = archived;
      }
      const del = root.querySelector("#deletePr");
      if (del) {
        del.hidden = false;
        del.className = "danger";
      }
      const rename = root.querySelector("#renamePr");
      if (rename) {
        const saving = msg.titleSaveInFlightId === selected.id;
        rename.hidden = archived;
        rename.disabled = archived || saving;
        rename.textContent = saving ? "Saving…" : "Rename";
      }
      const reopen = root.querySelector("#reopenPr");
      if (reopen) reopen.hidden = !archived;
      const openDiffs = root.querySelector("#openDiffs");
      if (openDiffs) openDiffs.className = "secondary";
      const hint = root.querySelector("#hint");
      if (hint) {
        hint.textContent = archived
          ? "Archived after opening on GitHub (or Archive locally). Reopen to continue, or Delete to remove the record."
          : reviewed && exportUi.hint
            ? exportUi.hint
            : ready
              ? "Waiting on the reviewer. Complete review if you finished a sidebar pass, or Open on GitHub anyway to skip."
              : COMPOSER_HINT;
      }
      const sum = root.querySelector("#sum");
      const next = selected.body || "";
      if (sum) {
        sum.readOnly = archived;
        if (document.activeElement !== sum && sum.value === serverSum) setTextarea(sum, next);
      }
      serverSum = next;
      const save = root.querySelector("#saveSum");
      if (save) save.hidden = archived;
      const composer = root.querySelector(".composer");
      if (composer) composer.hidden = archived;
    }
    function setList(el, html, paintedKey) {
      if (!el) return false;
      if (paintedKey === "files" && html === paintedFiles) return false;
      if (paintedKey === "comments" && html === paintedComments) return false;
      const y = el.scrollTop;
      el.innerHTML = html;
      el.scrollTop = y;
      if (paintedKey === "files") paintedFiles = html;
      else paintedComments = html;
      return true;
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "progress") {
        liveProgress = msg.progress || null;
        if (lastMsg) lastMsg = Object.assign({}, lastMsg, { progress: liveProgress });
        if (lastSelected && lastMsg) paintChrome(lastSelected, lastMsg);
        return;
      }
      if (msg.type !== "snapshot") return;
      lastMsg = msg;
      if (Object.prototype.hasOwnProperty.call(msg, "progress")) {
        const incoming = msg.progress || null;
        if (
          !incoming &&
          liveProgress &&
          !liveProgress.cancelled &&
          (liveProgress.kind === "export" || liveProgress.kind === "gate")
        ) {
          lastMsg = Object.assign({}, msg, { progress: liveProgress });
        } else {
          liveProgress = incoming;
        }
      }
      if (msg.error) {
        layoutId = null;
        paintedFiles = "";
        paintedComments = "";
        root.innerHTML = '<p class="error"></p>';
        root.firstChild.textContent = msg.error;
        return;
      }
      const selected = (msg.prs || []).find((p) => p.id === msg.selectedId);
      if (!selected) {
        layoutId = null;
        paintedFiles = "";
        paintedComments = "";
        const n = msg.archivedCount || 0;
        root.innerHTML = n
          ? '<p class="muted empty">Select a loop in Local PRs. Show archived to view exported loops.</p>'
          : '<p class="muted empty">Select a loop in Local PRs. File diffs open in the editor like Source Control, for that loop\\'s worktree.</p>';
        return;
      }
      const reuse = layoutId === selected.id && root.querySelector("#sum") && root.querySelector("#cmt") && root.querySelector("#clist") && root.querySelector("#flist");
      const files = msg.files || [];
      const threads = msg.threads || [];
      const where = selected.worktreePath ? "worktree" : "head";
      const fileHtml = files.map((f) => {
        const st = stLabel(f.status);
        return '<div class="file" data-path="' + esc(f.path) + '" data-status="' + esc(f.status) + '"><span class="st ' + st.c + '">' + esc(st.t) + '</span><span>' + esc(fileLabel(f.path)) + "</span></div>";
      }).join("") || '<p class="muted empty">No files changed</p>';
      const archivedView = selected.status === "approved";
      const commentHtml = threads.map((t) => {
        const c = t.root;
        const st = c.status || (c.resolvedAt ? "resolved" : "open");
        const loc = c.path
          ? '<button type="button" class="loc secondary" data-path="' + esc(c.path) + '" data-line="' + (c.line || "") + '">' + esc(c.path) + (c.line ? ":" + c.line : "") + "</button>"
          : "";
        const manage = !archivedView && st === "open" && (c.role === "human" || c.role === "reviewer")
          ? '<button type="button" class="edit secondary" data-cid="' + esc(c.id) + '" title="Edit finding">Edit</button><button type="button" class="delete-c danger" data-cid="' + esc(c.id) + '" title="Delete finding">Delete</button>'
          : "";
        const action = archivedView
          ? ""
          : st === "open" && (c.role === "human" || c.role === "reviewer")
            ? '<button type="button" class="address success" data-cid="' + esc(c.id) + '" title="Mark addressed">Addressed</button>'
            : st === "addressed"
              ? '<button type="button" class="resolve resolve-btn" data-cid="' + esc(c.id) + '" title="Resolve finding">Resolve</button>'
              : "";
        const replies = (t.replies || []).map((r) =>
          '<div class="reply"><div class="who muted"><span class="role">' + esc(roleLabel(r.role)) + "</span>" + esc(r.author || "agent") + " · " + esc(new Date(r.createdAt).toLocaleString()) + '</div><div class="body">' + esc(r.body) + "</div></div>"
        ).join("");
        return '<div class="thread ' + esc(st) + '"><div class="who muted"><span class="role">' + esc(roleLabel(c.role)) + '</span><span class="role ' + esc(st) + '">' + esc(st === "open" ? "open — needs action" : st) + "</span>" + esc(c.author || "reviewer") + " · " + esc(new Date(c.createdAt).toLocaleString()) + loc + manage + action + '</div><div class="body">' + esc(c.body) + "</div>" + (replies ? '<div class="replies">' + replies + "</div>" : "") + "</div>";
      }).join("") || '<p class="muted empty">No comments yet</p>';
      if (!reuse) {
        paintedFiles = "";
        paintedComments = "";
        root.innerHTML = [
          '<div class="toolbar">',
          "<h1></h1>",
          '<span class="pill"></span>',
          '<span class="muted" id="range"></span>',
          '<div class="run-progress" id="runProgress" hidden>',
          '<span class="spinner" id="runSpinner"></span>',
          '<span class="step" id="runStep"></span>',
          '<button type="button" class="secondary" id="cancelProgress">Cancel</button>',
          '<button type="button" class="secondary" id="retryProgress" hidden>Retry CI</button>',
          '</div>',
          '<div class="ci-card" id="ciCard" hidden></div>',
          '<div class="actions">',
          '<button id="exportPr" class="cta">' + EXPORT_PRIMARY + '</button>',
          '<span class="muted" id="exportBusyHint" hidden></span>',
          '<button class="secondary" id="completeReview">Complete review</button>',
          '<button class="secondary" id="openDiffs">Open diffs</button>',
          '<button class="secondary" id="markReady" data-s="ready">Mark ready</button>',
          '<button class="secondary" id="requestChanges" data-s="changes_requested">Request changes</button>',
          '<button class="secondary" id="archivePr" data-s="approved">Archive locally</button>',
          '<button class="secondary" id="copyReview">Copy review prompt</button>',
          '<button class="secondary" id="openWt"></button>',
          '<button class="secondary" id="openTerminal">Open terminal</button>',
          '<button class="secondary" id="renamePr">Rename</button>',
          '<button class="secondary" id="reopenPr">Reopen</button>',
          '<span class="spacer"></span>',
          '<button class="danger" id="deletePr">Delete</button>',
          "</div>",
          "</div>",
          '<div class="summary"><h2>Summary</h2><div class="pad"><textarea id="sum" placeholder="Why this exists, what changed, how to test. The implementing agent writes this for reviewers."></textarea><div style="margin-top:6px"><button id="saveSum">Save summary</button></div></div></div>',
          '<div class="body">',
          '<div class="files"><h2>Changes (' + where + ')</h2><div id="flist">' + fileHtml + '</div><p class="muted empty">Click a file to open the VS Code diff — loop base on the left, this worktree on the right.</p></div>',
          '<div class="comments"><h2>Comments</h2><div id="clist">' + commentHtml + '</div><div class="composer"><p class="muted hint" id="hint">' + COMPOSER_HINT + '</p><textarea id="cmt" placeholder="Comment for the agent working this PR"></textarea><div style="margin-top:6px"><button id="send">Comment</button></div></div></div>',
          "</div>",
          ${JSON.stringify(ciModalHtml())}
        ].join("");
        paintedFiles = fileHtml;
        paintedComments = commentHtml;
        bindChrome(selected, msg);
        bindFiles();
        bindComments(selected);
        const sum = root.querySelector("#sum");
        if (sum) sum.value = selected.body || "";
        root.querySelector("#cmt").value = "";
      } else {
        const filesChanged = setList(root.querySelector("#flist"), fileHtml, "files");
        const commentsChanged = setList(root.querySelector("#clist"), commentHtml, "comments");
        if (filesChanged) bindFiles();
        if (commentsChanged) bindComments(selected);
      }
      layoutId = selected.id;
      lastSelected = selected;
      paintChrome(selected, msg);
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
