import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  addLocalPrComment,
  addressLocalPrComment,
  commentThreads,
  consoleDir,
  createLocalPr,
  ensureWorktreeForLoop,
  findGitRoot,
  getLocalPrNameStatus,
  isArchivedPr,
  listLocalPrs,
  loopWorktreeIdentity,
  pruneArchivedLoopWorktree,
  resolveLocalPrComment,
  sameFsPath,
  setLocalPrStatus,
  updateLocalPr,
  archiveLoopsMergedOnGithub,
  exportLocalPr,
  type LocalPr,
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
  | { type: "openDiffs" }
  | { type: "export"; id: string };

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

  constructor(private readonly context: vscode.ExtensionContext) {
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

  private async onMessage(msg: ClientMessage): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.pushSnapshot(true);
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
        await setLocalPrStatus(cwd, msg.id, msg.status);
        await this.pushSnapshot();
      } else if (msg.type === "export") {
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        const title = pr?.title ?? msg.id;
        const pick = await vscode.window.showInformationMessage(
          `Export "${title}" to GitHub? This pushes the loop branch and opens a pull request.`,
          { modal: true },
          "Export",
        );
        if (pick !== "Export") return;
        const result = await exportLocalPr(cwd, msg.id);
        await this.pushSnapshot(true);
        const open = await vscode.window.showInformationMessage(
          result.alreadyExisted ? `GitHub PR already exists: ${result.url}` : `Opened ${result.url}`,
          "Open",
        );
        if (open === "Open") await vscode.env.openExternal(vscode.Uri.parse(result.url));
      } else if (msg.type === "comment") {
        await addLocalPrComment(cwd, msg.id, msg.body, { role: "human" });
        await this.pushSnapshot();
      } else if (msg.type === "address") {
        const note = await vscode.window.showInputBox({
          title: "Address comment",
          prompt: "How did you address this? This reply sits under the reviewer comment.",
        });
        if (note === undefined) return;
        await addressLocalPrComment(cwd, msg.id, msg.commentId, note);
        await this.pushSnapshot();
      } else if (msg.type === "resolve") {
        const note = await vscode.window.showInputBox({
          title: "Resolve comment",
          prompt: "Confirm this is fixed. This marks the thread resolved for human review.",
        });
        if (note === undefined) return;
        await resolveLocalPrComment(cwd, msg.id, msg.commentId, note, { role: "human" });
        await this.pushSnapshot();
      } else if (msg.type === "summary") {
        await updateLocalPr(cwd, msg.id, { body: msg.body });
        await this.pushSnapshot();
      } else if (msg.type === "copyReviewPrompt") {
        const prompt = [
          `Review local PR ${msg.id} with PR Genie.`,
          "Call get_diff. Post new findings with add_comment role=reviewer.",
          "On a second pass, resolve_comment each addressed finding or complete_review if nothing else is wrong.",
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
      const prs = all.filter((p) => !isArchivedPr(p));
      const ids = prs.map((p) => p.id);
      const freshIds = this.primed ? ids.filter((id) => !this.knownIds.has(id)) : [];
      this.primed = true;
      for (const id of ids) this.knownIds.add(id);
      if (freshIds.length && !this.userPinned) this.selectedId = freshIds[0];
      if (this.selectedId && !prs.some((p) => p.id === this.selectedId)) {
        this.selectedId = prs[0]?.id;
      }
      if (!this.selectedId) this.selectedId = prs[0]?.id;
      const selected = prs.find((p) => p.id === this.selectedId);
      const files = selected ? await getLocalPrNameStatus(root, selected.id) : [];
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const hereId =
        prs.find((p) => p.worktreePath && sameFsPath(p.worktreePath, folder))?.id ?? null;
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
    repo: "repo" in payload ? payload.repo : "",
    files: "files" in payload ? payload.files : [],
    threads: "threads" in payload ? payload.threads : [],
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
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .status {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
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
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px 8px;
      font-size: 11px;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); flex: none; }
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
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; }
  </style>
</head>
<body>
  <div class="meta"><span class="dot"></span><span class="muted" id="meta">Watching</span></div>
  <div id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");
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
      if (msg.error) {
        meta.textContent = "Watching";
        list.innerHTML = '<p class="error"></p>';
        list.firstChild.textContent = msg.error;
        return;
      }
      const prs = msg.prs || [];
      const fresh = new Set(msg.freshIds || []);
      const archived = msg.archivedCount || 0;
      meta.textContent = (msg.repo ? msg.repo + " · " : "") + prs.length + " loop" + (prs.length === 1 ? "" : "s")
        + (archived ? " · " + archived + " archived" : "");
      if (!prs.length) {
        const emptyText = archived
          ? "No active loops. " + archived + " archived after export."
          : "Waiting for agents. Loops land here when work is committed.";
        if (list.dataset.empty !== emptyText) {
          list.innerHTML = '<p class="muted empty"></p>';
          list.firstChild.textContent = emptyText;
          list.dataset.empty = emptyText;
        }
        return;
      }
      delete list.dataset.empty;
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
        el.className = "pr" + (pr.id === msg.selectedId ? " active" : "") + (fresh.has(pr.id) ? " fresh" : "") + (here ? " here" : "");
        const src = pr.source && pr.source.kind === "subagent"
          ? (pr.source.subagentType || "subagent")
          : (pr.source && pr.source.kind) || "local";
        const info = el.querySelector(".info");
        info.children[0].textContent = pr.status === "reviewed"
          ? "reviewed — your turn"
          : pr.status.replace("_", " ");
        info.children[1].textContent = pr.title;
        info.children[2].textContent = src + " · " + pr.headRef + " → " + pr.baseRef;
        const go = el.querySelector(".go");
        go.textContent = here ? "Here" : "Switch";
        go.disabled = here;
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
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 36vw;
    }
    .pill {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
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
      root.querySelector("h1").textContent = selected.title;
      root.querySelector(".pill").textContent = selected.status.replace("_", " ");
      root.querySelector("#range").textContent =
        selected.id + " · " + selected.headRef + " → " + selected.baseRef + " · " + short(selected.headSha) + " " + (when ? "· " + when : "");
      const filesH2 = root.querySelector(".files h2");
      if (filesH2) filesH2.textContent = "Changes (" + (selected.worktreePath ? "worktree" : "head") + ")";
      root.querySelector("#openWt").textContent = selected.id === msg.hereId ? "This window" : "Switch to this loop";
      root.querySelector("#openWt").disabled = selected.id === msg.hereId;
      const exp = root.querySelector("#exportPr");
      if (exp) {
        const canExport = selected.status === "reviewed" || selected.status === "ready";
        exp.disabled = !canExport;
        exp.textContent = selected.status === "reviewed" ? "Export to GitHub" : "Export";
      }
      const hint = root.querySelector("#hint");
      if (hint) {
        hint.textContent = selected.status === "reviewed"
          ? "Agent review is done. Export opens the GitHub PR at origin. Archive keeps it local only."
          : selected.status === "ready"
            ? "Waiting on the reviewer, or Export now if you have looked at the diff."
            : "Open findings go to the implementor. Address nests a reply underneath. When status is reviewed, Export publishes the GitHub PR.";
      }
      const sum = root.querySelector("#sum");
      const next = selected.body || "";
      if (sum && document.activeElement !== sum && sum.value === serverSum) setTextarea(sum, next);
      serverSum = next;
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
        root.innerHTML = '<p class="muted empty">Select a loop in Local PRs. File diffs open in the editor like Source Control, for that loop\\'s worktree.</p>';
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
      const commentHtml = threads.map((t) => {
        const c = t.root;
        const st = c.status || (c.resolvedAt ? "resolved" : "open");
        const loc = c.path
          ? '<button type="button" class="loc secondary" data-path="' + esc(c.path) + '" data-line="' + (c.line || "") + '">' + esc(c.path) + (c.line ? ":" + c.line : "") + "</button>"
          : "";
        const action = st === "open" && (c.role === "human" || c.role === "reviewer")
          ? '<button type="button" class="address secondary" data-cid="' + esc(c.id) + '">Addressed</button>'
          : st === "addressed"
            ? '<button type="button" class="resolve secondary" data-cid="' + esc(c.id) + '">Resolve</button>'
            : "";
        const replies = (t.replies || []).map((r) =>
          '<div class="reply"><div class="who muted"><span class="role">' + esc(roleLabel(r.role)) + "</span>" + esc(r.author || "agent") + " · " + esc(new Date(r.createdAt).toLocaleString()) + '</div><div class="body">' + esc(r.body) + "</div></div>"
        ).join("");
        return '<div class="thread ' + esc(st) + '"><div class="who muted"><span class="role">' + esc(roleLabel(c.role)) + '</span><span class="role">' + esc(st) + "</span>" + esc(c.author || "reviewer") + " · " + esc(new Date(c.createdAt).toLocaleString()) + loc + action + '</div><div class="body">' + esc(c.body) + "</div>" + (replies ? '<div class="replies">' + replies + "</div>" : "") + "</div>";
      }).join("") || '<p class="muted empty">No comments yet</p>';
      if (!reuse) {
        paintedFiles = "";
        paintedComments = "";
        root.innerHTML = [
          '<div class="toolbar">',
          "<h1></h1>",
          '<span class="pill"></span>',
          '<span class="muted" id="range"></span>',
          '<span class="grow"></span>',
          '<button id="openDiffs">Open diffs</button>',
          '<button data-s="ready">Ready</button>',
          '<button id="exportPr">Export</button>',
          '<button class="secondary" data-s="approved">Archive</button>',
          '<button class="secondary" data-s="changes_requested">Request changes</button>',
          '<button class="secondary" id="copyReview">Copy review prompt</button>',
          '<button class="secondary" id="openWt"></button>',
          "</div>",
          '<div class="summary"><h2>Summary</h2><div class="pad"><textarea id="sum" placeholder="Why this exists, what changed, how to test. The implementing agent writes this for reviewers."></textarea><div style="margin-top:6px"><button id="saveSum">Save summary</button></div></div></div>',
          '<div class="body">',
          '<div class="files"><h2>Changes (' + where + ')</h2><div id="flist">' + fileHtml + '</div><p class="muted empty">Click a file to open the VS Code diff — loop base on the left, this worktree on the right.</p></div>',
          '<div class="comments"><h2>Comments</h2><div id="clist">' + commentHtml + '</div><div class="composer"><p class="muted hint" id="hint">Open findings go to the implementor. Address nests a reply underneath. When status is reviewed, Export publishes the GitHub PR.</p><textarea id="cmt" placeholder="Comment for the agent working this PR"></textarea><div style="margin-top:6px"><button id="send">Comment</button></div></div></div>',
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
