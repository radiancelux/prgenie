import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  addLocalPrComment,
  addressLocalPrComment,
  commentThreads,
  completeLocalPrReview,
  consoleDir,
  createLocalPr,
  deleteLocalPr,
  deleteLocalPrComment,
  editLocalPrComment,
  ensureWorktreeForLoop,
  findGitRoot,
  formatWatchLane,
  getLocalPrNameStatus,
  getRepoWatch,
  haltWatchRole,
  isArchivedPr,
  listLocalPrs,
  loopWorktreeIdentity,
  pruneArchivedLoopWorktree,
  reopenLocalPr,
  resolveLocalPrComment,
  resumeWatchRole,
  sameFsPath,
  setLocalPrStatus,
  updateLocalPr,
  archiveLoopsMergedOnGithub,
  exportLocalPr,
  type LocalPr,
  type WatchRole,
} from "@prgenie/core";
import { openAllChanges, openFileChange } from "./gitDiff.js";

type Surface = "lane" | "panel";

type ClientMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "create" }
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
  | { type: "watchStart"; role: WatchRole }
  | { type: "watchStop"; role: WatchRole }
  | { type: "openDiffs" }
  | { type: "export"; id: string }
  | { type: "showArchived"; value: boolean };

type WatchLaneSnapshot = {
  halted: boolean;
  reason: string | null;
  exportId: string | null;
  label: string;
};

type Snapshot = {
  type: "snapshot";
  error?: string;
  prs: LocalPr[];
  selectedId: string | null;
  files: { status: string; path: string }[];
  threads?: { root: LocalPr["comments"][number]; replies: LocalPr["comments"] }[];
  repo: string;
  freshIds: string[];
  watching: boolean;
  hereId: string | null;
  archivedCount?: number;
  showArchived?: boolean;
  watch?: { inbox: WatchLaneSnapshot; queue: WatchLaneSnapshot };
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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.showArchived = this.context.workspaceState.get("prgenie.showArchived", false);
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
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async openGitLens(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const candidates = [
      "gitlens.showGraph",
      "gitlens.showCommitGraph",
      "gitlens.showGraphPage",
    ];
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
      void vscode.window.showInformationMessage(
        "This loop is archived. The record is read-only.",
      );
      return true;
    }
    return false;
  }

  private async onMessage(msg: ClientMessage): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "showArchived") {
      this.showArchived = msg.value;
      await this.context.workspaceState.update("prgenie.showArchived", msg.value);
      await this.pushSnapshot(true);
      return;
    }
    if (msg.type === "watchStart" || msg.type === "watchStop") {
      const cwd = await this.repoCwd();
      if (!cwd) return;
      try {
        if (msg.type === "watchStart") await resumeWatchRole(cwd, msg.role);
        else await haltWatchRole(cwd, msg.role, "stop");
        await this.pushSnapshot(true);
      } catch (err) {
        void vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (msg.type === "create") {
      await this.createPr();
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
        void vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
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
        await setLocalPrStatus(cwd, msg.id, msg.status);
        await this.pushSnapshot();
      } else if (msg.type === "export") {
        if (await this.rejectIfArchived(cwd, msg.id)) return;
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        const title = pr?.title ?? msg.id;
        const pick = await vscode.window.showInformationMessage(
          `Open "${title}" on GitHub? This pushes the loop branch and creates a pull request.`,
          { modal: true },
          "Open on GitHub",
        );
        if (pick !== "Open on GitHub") return;
        const result = await exportLocalPr(cwd, msg.id);
        await this.pushSnapshot(true);
        const open = await vscode.window.showInformationMessage(
          result.alreadyExisted ? `GitHub PR already exists: ${result.url}` : `Opened ${result.url}`,
          "Open",
        );
        if (open === "Open") await vscode.env.openExternal(vscode.Uri.parse(result.url));
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
        const existing = pr?.comments.find((c) => c.id === msg.commentId || c.id.startsWith(msg.commentId));
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
          "Review prompt copied. Paste it in a new chat or run /review-local-pr.",
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
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
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

  private async pushSnapshot(force = false): Promise<void> {
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
              (p.id === parked.id ||
                (p.worktreePath && sameFsPath(p.worktreePath, root))),
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
      const due = force || Date.now() - this.lastGithubArchive > 30_000;
      if (due) {
        this.lastGithubArchive = Date.now();
        await archiveLoopsMergedOnGithub(root).catch(() => []);
      }
      const all = await listLocalPrs(root);
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
      if (freshIds.length && !this.userPinned) this.selectedId = freshIds[0];
      if (this.selectedId && !prs.some((p) => p.id === this.selectedId)) {
        this.selectedId = live[0]?.id ?? (this.showArchived ? archived[0]?.id : undefined);
      }
      if (!this.selectedId) this.selectedId = live[0]?.id ?? (this.showArchived ? archived[0]?.id : undefined);
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
      const watchState = await getRepoWatch(root);
      const laneSnap = (role: WatchRole): WatchLaneSnapshot => ({
        halted: watchState[role].halted,
        reason: watchState[role].reason,
        exportId: watchState[role].exportId,
        label: formatWatchLane(watchState, role),
      });
      this.post({
        type: "snapshot",
        prs,
        selectedId: this.selectedId ?? null,
        files,
        threads: selected ? commentThreads(selected.comments) : [],
        repo: path.basename(root),
        freshIds,
        watching: true,
        hereId,
        archivedCount,
        showArchived: this.showArchived,
        watch: { inbox: laneSnap("inbox"), queue: laneSnap("queue") },
      }, force);
      await this.watchStore();
    } catch (err) {
      this.post({
        type: "snapshot",
        error: err instanceof Error ? err.message : String(err),
        prs: [],
      }, force);
    }
  }
}

function snapshotKey(
  payload: Snapshot | { type: "snapshot"; error: string; prs: [] },
): string {
  return JSON.stringify({
    error: payload.error ?? null,
    selectedId: "selectedId" in payload ? payload.selectedId : null,
    hereId: "hereId" in payload ? payload.hereId : null,
    archivedCount: "archivedCount" in payload ? payload.archivedCount : 0,
    showArchived: "showArchived" in payload ? payload.showArchived : false,
    repo: "repo" in payload ? payload.repo : "",
    files: "files" in payload ? payload.files : [],
    threads: "threads" in payload ? payload.threads : [],
    watch: "watch" in payload ? payload.watch : null,
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
    .status {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .status.your-turn {
      color: var(--vscode-charts-green, #3fb950);
      font-weight: 600;
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
    .watch {
      display: flex; flex-direction: column; gap: 4px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
    }
    .watch-row {
      display: flex; align-items: center; gap: 8px;
    }
    .watch-row .role {
      width: 42px; flex: none; text-transform: uppercase; letter-spacing: 0.04em;
      font-size: 10px; color: var(--vscode-descriptionForeground);
    }
    .watch-row .state { flex: 1; min-width: 0; }
    .watch-row button { flex: none; font-size: 11px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); flex: none; }
    .dot.off { background: var(--vscode-descriptionForeground); }
    .pr {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    .pr .info { flex: 1; min-width: 0; }
    .pr .go { flex: none; font-size: 11px; padding: 2px 6px; margin-top: 2px; }
    .pr:hover { background: var(--vscode-list-hoverBackground); }
    .pr.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }
    .pr.here { border-left-color: var(--vscode-charts-green, #3fb950); }
    .pr.fresh { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
    .pr.reviewed-turn { border-left-color: var(--vscode-charts-green, #3fb950); }
    .pr.archived { opacity: 0.72; }
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; }
    .meta-top button { margin-left: auto; font-size: 11px; }
    .meta-top button.on { outline: 1px solid var(--vscode-focusBorder); }
  </style>
</head>
<body>
  <div class="meta">
    <div class="watch" id="watch" hidden>
      <div class="watch-row" data-role="inbox">
        <span class="role">inbox</span>
        <span class="state muted" id="inboxState">—</span>
        <button type="button" class="secondary" id="inboxBtn" disabled>Start</button>
      </div>
      <div class="watch-row" data-role="queue">
        <span class="role">queue</span>
        <span class="state muted" id="queueState">—</span>
        <button type="button" class="secondary" id="queueBtn" disabled>Start</button>
      </div>
    </div>
    <div class="meta-top"><span class="dot off" id="dot"></span><span class="muted" id="meta">Watching</span><button type="button" class="secondary" id="archivedToggle">Show archived</button></div>
  </div>
  <div id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");
    const toggle = document.getElementById("archivedToggle");
    const watchBox = document.getElementById("watch");
    toggle.onclick = () => vscode.postMessage({ type: "showArchived", value: !toggle.classList.contains("on") });
    function bindWatchBtn(role, btn) {
      btn.onclick = () => {
        if (btn.disabled) return;
        const halted = btn.dataset.halted === "1";
        vscode.postMessage({ type: halted ? "watchStart" : "watchStop", role });
      };
    }
    bindWatchBtn("inbox", document.getElementById("inboxBtn"));
    bindWatchBtn("queue", document.getElementById("queueBtn"));
    function paintLane(role, lane) {
      const state = document.getElementById(role + "State");
      const btn = document.getElementById(role + "Btn");
      if (!state || !btn) return;
      if (!lane) {
        state.textContent = "—";
        btn.dataset.halted = "1";
        btn.textContent = "Start";
        btn.disabled = true;
        return;
      }
      const halted = !!lane.halted;
      state.textContent = lane.label || (halted ? "halted" : "listening");
      btn.dataset.halted = halted ? "1" : "0";
      btn.textContent = halted ? "Start" : "Stop";
      btn.disabled = false;
    }
    function paintWatch(msg) {
      const dot = document.getElementById("dot");
      const hasWatch = !!(msg.watch && msg.watch.inbox && msg.watch.queue) && !msg.error;
      if (watchBox) watchBox.hidden = !hasWatch;
      if (!hasWatch) {
        paintLane("inbox", null);
        paintLane("queue", null);
        if (dot) dot.classList.add("off");
        return;
      }
      paintLane("inbox", msg.watch.inbox);
      paintLane("queue", msg.watch.queue);
      const anyListening = !msg.watch.inbox.halted || !msg.watch.queue.halted;
      if (dot) dot.classList.toggle("off", !anyListening);
    }
    function prRow(id) {
      const el = document.createElement("div");
      el.dataset.id = id;
      el.innerHTML = '<div class="info"><div class="status"></div><div class="title"></div><div class="muted"></div></div><button class="go secondary"></button>';
      el.querySelector(".go").onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openFolder", id: el.dataset.id });
      };
      el.onclick = () => vscode.postMessage({ type: "select", id: el.dataset.id });
      return el;
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "snapshot") return;
      const meta = document.getElementById("meta");
      paintWatch(msg);
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
        const emptyText = archived
          ? "No active loops. " + archived + " archived after export. Show archived to view them."
          : "Waiting for agents. Loops land here when work is committed.";
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
        const yourTurn = pr.status === "reviewed";
        el.className = "pr"
          + (pr.id === msg.selectedId ? " active" : "")
          + (fresh.has(pr.id) ? " fresh" : "")
          + (here ? " here" : "")
          + (archivedPr ? " archived" : "")
          + (yourTurn ? " reviewed-turn" : "");
        const src = pr.source && pr.source.kind === "subagent"
          ? (pr.source.subagentType || "subagent")
          : (pr.source && pr.source.kind) || "local";
        const info = el.querySelector(".info");
        const statusEl = info.children[0];
        statusEl.className = "status" + (yourTurn ? " your-turn" : "");
        statusEl.textContent = archivedPr
          ? "archived"
          : yourTurn
            ? "your turn — open on GitHub"
            : pr.status.replace("_", " ");
        info.children[1].textContent = pr.title;
        info.children[1].title = pr.title;
        info.children[2].textContent = src + " · " + pr.headRef + " → " + pr.baseRef;
        const go = el.querySelector(".go");
        go.textContent = archivedPr ? "Archived" : here ? "Here" : "Switch";
        go.disabled = archivedPr || here;
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
    .pill.your-turn {
      background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 28%, var(--vscode-badge-background));
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
    const root = document.getElementById("root");
    let layoutId = null;
    let serverSum = "";
    let paintedFiles = "";
    let paintedComments = "";
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
      root.querySelector("#copyReview").onclick = () => vscode.postMessage({ type: "copyReviewPrompt", id: selected.id });
      root.querySelector("#openDiffs").onclick = () => vscode.postMessage({ type: "openDiffs" });
      const exp = root.querySelector("#exportPr");
      if (exp) exp.onclick = () => vscode.postMessage({ type: "export", id: selected.id });
      const complete = root.querySelector("#completeReview");
      if (complete) complete.onclick = () => vscode.postMessage({ type: "completeReview", id: selected.id });
      const del = root.querySelector("#deletePr");
      if (del) del.onclick = () => vscode.postMessage({ type: "deletePr", id: selected.id });
      const reopen = root.querySelector("#reopenPr");
      if (reopen) reopen.onclick = () => vscode.postMessage({ type: "reopenPr", id: selected.id });
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
      root.querySelector("h1").textContent = selected.title;
      root.querySelector("h1").title = selected.title;
      const pill = root.querySelector(".pill");
      pill.textContent = reviewed ? "your turn" : selected.status.replace("_", " ");
      pill.className = "pill" + (reviewed ? " your-turn" : "");
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
      if (ship) {
        if (archived) {
          ship.hidden = true;
        } else if (reviewed) {
          ship.hidden = false;
          ship.disabled = false;
          ship.className = "cta";
          ship.textContent = "Open on GitHub";
        } else if (ready) {
          ship.hidden = false;
          ship.disabled = false;
          ship.className = "secondary";
          ship.textContent = "Open on GitHub anyway";
        } else {
          ship.hidden = true;
        }
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
      const reopen = root.querySelector("#reopenPr");
      if (reopen) reopen.hidden = !archived;
      const openDiffs = root.querySelector("#openDiffs");
      if (openDiffs) openDiffs.className = "secondary";
      const hint = root.querySelector("#hint");
      if (hint) {
        hint.textContent = archived
          ? "Archived after opening on GitHub (or Archive locally). Reopen to continue, or Delete to remove the record."
          : reviewed
            ? "Review is done — your turn. Open on GitHub pushes the branch and creates the pull request. Archive locally keeps it local only."
            : ready
              ? "Waiting on the reviewer. Complete review if you finished a sidebar pass, or Open on GitHub anyway to skip."
              : "Open findings go to the implementor. Address nests a reply underneath. When status is your turn, Open on GitHub creates the PR.";
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
      if (msg.type !== "snapshot") return;
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
          ? '<button type="button" class="edit secondary" data-cid="' + esc(c.id) + '">Edit</button><button type="button" class="delete-c secondary" data-cid="' + esc(c.id) + '">Delete</button>'
          : "";
        const action = archivedView
          ? ""
          : st === "open" && (c.role === "human" || c.role === "reviewer")
            ? '<button type="button" class="address secondary" data-cid="' + esc(c.id) + '">Addressed</button>'
            : st === "addressed"
              ? '<button type="button" class="resolve secondary" data-cid="' + esc(c.id) + '">Resolve</button>'
              : "";
        const replies = (t.replies || []).map((r) =>
          '<div class="reply"><div class="who muted"><span class="role">' + esc(roleLabel(r.role)) + "</span>" + esc(r.author || "agent") + " · " + esc(new Date(r.createdAt).toLocaleString()) + '</div><div class="body">' + esc(r.body) + "</div></div>"
        ).join("");
        return '<div class="thread ' + esc(st) + '"><div class="who muted"><span class="role">' + esc(roleLabel(c.role)) + '</span><span class="role">' + esc(st) + "</span>" + esc(c.author || "reviewer") + " · " + esc(new Date(c.createdAt).toLocaleString()) + loc + manage + action + '</div><div class="body">' + esc(c.body) + "</div>" + (replies ? '<div class="replies">' + replies + "</div>" : "") + "</div>";
      }).join("") || '<p class="muted empty">No comments yet</p>';
      if (!reuse) {
        paintedFiles = "";
        paintedComments = "";
        root.innerHTML = [
          '<div class="toolbar">',
          "<h1></h1>",
          '<span class="pill"></span>',
          '<span class="muted" id="range"></span>',
          '<div class="actions">',
          '<button id="exportPr" class="cta">Open on GitHub</button>',
          '<button class="secondary" id="completeReview">Complete review</button>',
          '<button class="secondary" id="openDiffs">Open diffs</button>',
          '<button class="secondary" id="markReady" data-s="ready">Mark ready</button>',
          '<button class="secondary" id="requestChanges" data-s="changes_requested">Request changes</button>',
          '<button class="secondary" id="archivePr" data-s="approved">Archive locally</button>',
          '<button class="secondary" id="copyReview">Copy review prompt</button>',
          '<button class="secondary" id="openWt"></button>',
          '<button class="secondary" id="reopenPr">Reopen</button>',
          '<span class="spacer"></span>',
          '<button class="danger" id="deletePr">Delete</button>',
          "</div>",
          "</div>",
          '<div class="summary"><h2>Summary</h2><div class="pad"><textarea id="sum" placeholder="Why this exists, what changed, how to test. The implementing agent writes this for reviewers."></textarea><div style="margin-top:6px"><button id="saveSum">Save summary</button></div></div></div>',
          '<div class="body">',
          '<div class="files"><h2>Changes (' + where + ')</h2><div id="flist">' + fileHtml + '</div><p class="muted empty">Click a file to open the VS Code diff — loop base on the left, this worktree on the right.</p></div>',
          '<div class="comments"><h2>Comments</h2><div id="clist">' + commentHtml + '</div><div class="composer"><p class="muted hint" id="hint">Open findings go to the implementor. Address nests a reply underneath. When status is your turn, Open on GitHub creates the PR.</p><textarea id="cmt" placeholder="Comment for the agent working this PR"></textarea><div style="margin-top:6px"><button id="send">Comment</button></div></div></div>',
          "</div>"
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
      paintChrome(selected, msg);
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
