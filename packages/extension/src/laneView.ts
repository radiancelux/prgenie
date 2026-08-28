import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  addLocalPrComment,
  consoleDir,
  createLocalPr,
  findGitRoot,
  getLocalPrNameStatus,
  listLocalPrs,
  setLocalPrStatus,
  updateLocalPr,
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
  | { type: "openDiffs" };

type Snapshot = {
  type: "snapshot";
  error?: string;
  prs: LocalPr[];
  selectedId: string | null;
  files: { status: string; path: string }[];
  repo: string;
  freshIds: string[];
  watching: boolean;
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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.poller = setInterval(() => void this.pushSnapshot(), 2000);
  }

  provider(surface: Surface): vscode.WebviewViewProvider {
    return {
      resolveWebviewView: (webviewView) => this.resolve(surface, webviewView),
    };
  }

  refresh(): void {
    void this.pushSnapshot();
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
    void this.pushSnapshot();
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
      await this.pushSnapshot();
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
      } else if (msg.type === "comment") {
        await addLocalPrComment(cwd, msg.id, msg.body, { role: "human" });
        await this.pushSnapshot();
      } else if (msg.type === "summary") {
        await updateLocalPr(cwd, msg.id, { body: msg.body });
        await this.pushSnapshot();
      } else if (msg.type === "copyReviewPrompt") {
        const prompt = [
          `Review local PR ${msg.id} with PR Genie.`,
          "Call get_diff, then add_comment with role reviewer for each finding (or one summary).",
          "Do not implement fixes unless I ask. Do not git push.",
        ].join(" ");
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage(
          "Review prompt copied. Paste it in a new chat or run /review-local-pr.",
        );
      } else if (msg.type === "openFolder") {
        const prs = await listLocalPrs(cwd);
        const pr = prs.find((p) => p.id === msg.id);
        if (pr?.worktreePath) {
          await vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(pr.worktreePath),
            { forceNewWindow: true },
          );
        } else {
          void vscode.window.showInformationMessage(
            "No live worktree for this loop. The branch and local PR still exist.",
          );
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private post(payload: Snapshot | { type: "snapshot"; error: string; prs: [] }): void {
    for (const view of this.views.values()) {
      void view.webview.postMessage(payload);
    }
  }

  private async pushSnapshot(): Promise<void> {
    if (this.views.size === 0) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.post({ type: "snapshot", error: "Open a git repository.", prs: [] });
      return;
    }
    const root = await findGitRoot(cwd);
    if (!root) {
      this.post({ type: "snapshot", error: "Not a git repository.", prs: [] });
      return;
    }
    try {
      const prs = await listLocalPrs(root);
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
      this.post({
        type: "snapshot",
        prs,
        selectedId: this.selectedId ?? null,
        files,
        repo: path.basename(root),
        freshIds,
        watching: true,
      });
      await this.watchStore();
    } catch (err) {
      this.post({
        type: "snapshot",
        error: err instanceof Error ? err.message : String(err),
        prs: [],
      });
    }
  }
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
      padding: 6px 12px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    .pr:hover { background: var(--vscode-list-hoverBackground); }
    .pr.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }
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
      meta.textContent = (msg.repo ? msg.repo + " · " : "") + prs.length + " loop" + (prs.length === 1 ? "" : "s");
      list.innerHTML = "";
      if (!prs.length) {
        list.innerHTML = '<p class="muted empty">Waiting for agents. Loops land here when work is committed.</p>';
        return;
      }
      for (const pr of prs) {
        const el = document.createElement("div");
        el.className = "pr" + (pr.id === msg.selectedId ? " active" : "") + (fresh.has(pr.id) ? " fresh" : "");
        const src = pr.source && pr.source.kind === "subagent"
          ? (pr.source.subagentType || "subagent")
          : (pr.source && pr.source.kind) || "local";
        el.innerHTML = '<div class="status"></div><div class="title"></div><div class="muted"></div>';
        el.children[0].textContent = pr.status.replace("_", " ");
        el.children[1].textContent = pr.title;
        el.children[2].textContent = src + " · " + pr.headRef + " → " + pr.baseRef;
        el.onclick = () => vscode.postMessage({ type: "select", id: pr.id });
        list.appendChild(el);
      }
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
      flex: 1; overflow: auto;
      border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .files h2, .comments h2, .summary h2 {
      font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
      margin: 0; padding: 8px 10px; color: var(--vscode-descriptionForeground);
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
      width: 280px; flex: none; overflow: auto; display: flex; flex-direction: column;
    }
    .comment { padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .comment .who { font-size: 11px; margin-bottom: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
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
    .composer { padding: 8px 10px; }
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
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "snapshot") return;
      if (msg.error) {
        layoutId = null;
        root.innerHTML = '<p class="error"></p>';
        root.firstChild.textContent = msg.error;
        return;
      }
      const selected = (msg.prs || []).find((p) => p.id === msg.selectedId);
      if (!selected) {
        layoutId = null;
        root.innerHTML = '<p class="muted empty">Select a loop in Local PRs. File diffs open in the editor like Source Control, for that loop\\'s worktree.</p>';
        return;
      }
      const prevSum = root.querySelector("#sum");
      const prevCmt = root.querySelector("#cmt");
      const reuse = layoutId === selected.id && prevSum && prevCmt;
      const keepSum = reuse && (document.activeElement === prevSum || prevSum.value !== serverSum);
      const keepCmt = reuse && (document.activeElement === prevCmt || prevCmt.value.length > 0);
      const draftSum = keepSum ? prevSum.value : (selected.body || "");
      const draftCmt = keepCmt ? prevCmt.value : "";
      const files = msg.files || [];
      const comments = selected.comments || [];
      const short = (sha) => (sha || "").slice(0, 7);
      const when = selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : "";
      const where = selected.worktreePath ? "worktree" : "head";
      const fileHtml = files.map((f) => {
        const st = stLabel(f.status);
        return '<div class="file" data-path="' + esc(f.path) + '" data-status="' + esc(f.status) + '"><span class="st ' + st.c + '">' + esc(st.t) + '</span><span>' + esc(fileLabel(f.path)) + "</span></div>";
      }).join("") || '<p class="muted empty">No files changed</p>';
      function roleLabel(role) {
        if (role === "agent") return "Agent";
        if (role === "reviewer") return "Reviewer";
        return "Human";
      }
      const commentHtml = comments.map((c) => {
        const loc = c.path
          ? '<button type="button" class="loc secondary" data-path="' + esc(c.path) + '" data-line="' + (c.line || "") + '">' + esc(c.path) + (c.line ? ":" + c.line : "") + "</button>"
          : "";
        return '<div class="comment"><div class="who muted"><span class="role">' + esc(roleLabel(c.role)) + "</span>" + esc(c.author || "reviewer") + " · " + esc(new Date(c.createdAt).toLocaleString()) + loc + "</div><div>" + esc(c.body) + "</div></div>";
      }).join("") || '<p class="muted empty">No comments yet</p>';
      root.innerHTML = [
        '<div class="toolbar">',
        "<h1></h1>",
        '<span class="pill"></span>',
        '<span class="muted" id="range"></span>',
        '<span class="grow"></span>',
        '<button id="openDiffs">Open diffs</button>',
        '<button data-s="ready">Ready</button>',
        '<button data-s="approved">Approve</button>',
        '<button class="secondary" data-s="changes_requested">Request changes</button>',
        '<button class="secondary" id="copyReview">Copy review prompt</button>',
        '<button class="secondary" id="openWt">Worktree</button>',
        "</div>",
        '<div class="summary"><h2>Summary</h2><div class="pad"><textarea id="sum" placeholder="Why this exists, what changed, how to test. The implementing agent writes this for reviewers."></textarea><div style="margin-top:6px"><button id="saveSum">Save summary</button></div></div></div>',
        '<div class="body">',
        '<div class="files"><h2>Changes (' + where + ')</h2>' + fileHtml + '<p class="muted empty">Click a file to open the VS Code diff — loop base on the left, this worktree on the right.</p></div>',
        '<div class="comments"><h2>Comments</h2><div id="clist">' + commentHtml + '</div><div class="composer"><p class="muted hint">Goes to the agent on this loop (next chat on this branch). Status becomes changes requested, including from draft.</p><textarea id="cmt" placeholder="Comment for the agent working this PR"></textarea><div style="margin-top:6px"><button id="send">Comment</button></div></div></div>',
        "</div>"
      ].join("");
      layoutId = selected.id;
      serverSum = selected.body || "";
      root.querySelector("h1").textContent = selected.title;
      root.querySelector(".pill").textContent = selected.status.replace("_", " ");
      root.querySelector("#range").textContent =
        selected.id + " · " + selected.headRef + " → " + selected.baseRef + " · " + short(selected.headSha) + " " + (when ? "· " + when : "");
      root.querySelector("#sum").value = draftSum;
      root.querySelector("#cmt").value = draftCmt;
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
      root.querySelector("#send").onclick = () => {
        const body = root.querySelector("#cmt").value;
        if (body.trim()) vscode.postMessage({ type: "comment", id: selected.id, body });
      };
      for (const el of root.querySelectorAll(".file[data-path]")) {
        el.onclick = () => vscode.postMessage({
          type: "openFile",
          path: el.getAttribute("data-path"),
          status: el.getAttribute("data-status") || "M"
        });
      }
      for (const el of root.querySelectorAll(".loc[data-path]")) {
        el.onclick = () => vscode.postMessage({
          type: "openComment",
          path: el.getAttribute("data-path"),
          line: Number(el.getAttribute("data-line") || 0) || undefined
        });
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
