import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  addLocalPrComment,
  consoleDir,
  createLocalPr,
  findGitRoot,
  getLocalPrDiff,
  getLocalPrNameStatus,
  listLocalPrs,
  setLocalPrStatus,
  type LocalPr,
} from "@prgenie/core";

type Surface = "lane" | "panel";

type ClientMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "create" }
  | { type: "select"; id: string }
  | { type: "status"; id: string; status: LocalPr["status"] }
  | { type: "comment"; id: string; body: string }
  | { type: "openFolder"; id: string }
  | { type: "openGitLens" }
  | { type: "openFile"; path: string };

type Snapshot = {
  type: "snapshot";
  error?: string;
  prs: LocalPr[];
  selectedId: string | null;
  files: { status: string; path: string }[];
  diff: string;
  repo: string;
  freshIds: string[];
  watching: boolean;
};

export class LaneHub implements vscode.Disposable {
  private readonly views = new Map<Surface, vscode.WebviewView>();
  private watcher: FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
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
    try {
      const pr = await createLocalPr(cwd, {
        title: title || undefined,
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
      "GitLens is not installed. Install it for history and the commit graph; PR Genie only shows local review packets.",
    );
  }

  dispose(): void {
    this.watcher?.close();
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
    this.watcher?.close();
    const cwd = await this.repoCwd({ warn: false });
    if (!cwd) return;
    try {
      const dir = await consoleDir(cwd);
      this.watcher = watch(dir, { recursive: true }, () => {
        void this.pushSnapshot();
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
    if (msg.type === "openFile") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, msg.path.replace(/\\/g, "/"));
      await vscode.window.showTextDocument(uri, { preview: true });
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
        await addLocalPrComment(cwd, msg.id, msg.body);
        await this.pushSnapshot();
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
            "No live worktree for this packet. The branch and local PR still exist.",
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
      let files: { status: string; path: string }[] = [];
      let diff = "";
      if (selected) {
        files = await getLocalPrNameStatus(root, selected.id);
        diff = await getLocalPrDiff(root, selected.id, { maxBytes: 160_000 });
      }
      this.post({
        type: "snapshot",
        prs,
        selectedId: this.selectedId ?? null,
        files,
        diff,
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
      meta.textContent = (msg.repo ? msg.repo + " · " : "") + prs.length + " packet" + (prs.length === 1 ? "" : "s");
      list.innerHTML = "";
      if (!prs.length) {
        list.innerHTML = '<p class="muted empty">Waiting for agents. Packets land here when work is committed.</p>';
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
      max-width: 42vw;
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
      width: 220px; flex: none; overflow: auto;
      border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .file {
      display: flex; gap: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px;
    }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file .st { width: 14px; flex: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .diff {
      flex: 1; overflow: auto; padding: 8px 12px;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 12px; line-height: 1.45; white-space: pre;
    }
    .add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .hunk { color: var(--vscode-textLink-foreground); }
    .meta { color: var(--vscode-descriptionForeground); }
    .comments {
      width: 260px; flex: none; overflow: auto; display: flex; flex-direction: column;
      border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .comments h2 {
      font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
      margin: 0; padding: 8px 10px; color: var(--vscode-descriptionForeground);
    }
    .comment { padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .comment .who { font-size: 11px; margin-bottom: 4px; }
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
    function esc(s) {
      return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    }
    function colorDiff(diff) {
      if (!diff) return '<span class="muted">(no diff — head matches base)</span>';
      return diff.split("\\n").map((line) => {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "add"
          : line.startsWith("-") && !line.startsWith("---") ? "del"
          : line.startsWith("@@") ? "hunk"
          : line.startsWith("diff ") || line.startsWith("index ") ? "meta"
          : "";
        return '<div class="' + cls + '">' + esc(line) + "</div>";
      }).join("");
    }
    function stLabel(s) {
      if (s === "A") return { t: "A", c: "add" };
      if (s === "D") return { t: "D", c: "del" };
      if (s === "M") return { t: "M", c: "" };
      return { t: s || "?", c: "" };
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "snapshot") return;
      if (msg.error) {
        root.innerHTML = '<p class="error"></p>';
        root.firstChild.textContent = msg.error;
        return;
      }
      const selected = (msg.prs || []).find((p) => p.id === msg.selectedId);
      if (!selected) {
        root.innerHTML = '<p class="muted empty">Select a packet in Local PRs. This panel is the review surface — GitLens stays next to it for history.</p>';
        return;
      }
      const files = msg.files || [];
      const comments = selected.comments || [];
      const short = (sha) => (sha || "").slice(0, 7);
      const when = selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : "";
      const fileHtml = files.map((f) => {
        const st = stLabel(f.status);
        return '<div class="file" data-path="' + esc(f.path) + '"><span class="st ' + st.c + '">' + esc(st.t) + '</span><span>' + esc(f.path) + "</span></div>";
      }).join("") || '<p class="muted empty">No files changed</p>';
      const commentHtml = comments.map((c) =>
        '<div class="comment"><div class="who muted">' + esc(c.author || "reviewer") + " · " + esc(new Date(c.createdAt).toLocaleString()) + "</div><div>" + esc(c.body) + "</div></div>"
      ).join("") || '<p class="muted empty">No comments yet</p>';
      root.innerHTML = [
        '<div class="toolbar">',
        "<h1></h1>",
        '<span class="pill"></span>',
        '<span class="muted" id="range"></span>',
        '<span class="grow"></span>',
        '<button data-s="ready">Ready</button>',
        '<button data-s="approved">Approve</button>',
        '<button class="secondary" data-s="changes_requested">Request changes</button>',
        '<button class="secondary" id="openWt">Worktree</button>',
        "</div>",
        '<div class="body">',
        '<div class="files">' + fileHtml + "</div>",
        '<div class="diff"></div>',
        '<div class="comments"><h2>Comments</h2><div id="clist">' + commentHtml + '</div><div class="composer"><textarea id="cmt" placeholder="Local review comment"></textarea><div style="margin-top:6px"><button id="send">Comment</button></div></div></div>',
        "</div>"
      ].join("");
      root.querySelector("h1").textContent = selected.title;
      root.querySelector(".pill").textContent = selected.status.replace("_", " ");
      root.querySelector("#range").textContent =
        selected.id + " · " + selected.headRef + " → " + selected.baseRef + " · " + short(selected.headSha) + " " + (when ? "· " + when : "");
      root.querySelector(".diff").innerHTML = colorDiff(msg.diff || "");
      for (const btn of root.querySelectorAll("button[data-s]")) {
        btn.onclick = () => vscode.postMessage({ type: "status", id: selected.id, status: btn.getAttribute("data-s") });
      }
      root.querySelector("#openWt").onclick = () => vscode.postMessage({ type: "openFolder", id: selected.id });
      root.querySelector("#send").onclick = () => {
        const body = root.querySelector("#cmt").value;
        if (body.trim()) vscode.postMessage({ type: "comment", id: selected.id, body });
      };
      for (const el of root.querySelectorAll(".file[data-path]")) {
        el.onclick = () => vscode.postMessage({ type: "openFile", path: el.getAttribute("data-path") });
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
