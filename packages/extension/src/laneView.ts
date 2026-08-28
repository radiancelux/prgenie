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

type ClientMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "create" }
  | { type: "select"; id: string }
  | { type: "status"; id: string; status: LocalPr["status"] }
  | { type: "comment"; id: string; body: string }
  | { type: "openFolder"; id: string }
  | { type: "openGitLens" };

export class LaneViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private watcher: FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private selectedId: string | undefined;
  private knownIds = new Set<string>();
  private primed = false;
  private userPinned = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
      void this.onMessage(msg);
    });
    void this.watchStore();
    this.poller = setInterval(() => void this.pushSnapshot(), 2000);
    void this.pushSnapshot();
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
      await this.pushSnapshot();
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.poller) clearInterval(this.poller);
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
    const cwd = await this.repoCwd();
    if (!cwd) return;
    try {
      if (msg.type === "select") {
        this.selectedId = msg.id;
        this.userPinned = true;
        await this.pushSnapshot();
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

  private async openGitLens(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const candidates = ["gitlens.showGraph", "gitlens.showCommitGraph", "gitlens.showGraphPage"];
    const found = candidates.find((c) => commands.includes(c));
    if (found) {
      await vscode.commands.executeCommand(found);
      return;
    }
    void vscode.window.showInformationMessage(
      "GitLens is not installed. Install it to open the commit graph; PR Genie will not duplicate that UI.",
    );
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.view) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.view.webview.postMessage({
        type: "snapshot",
        error: "Open a git repository.",
        prs: [],
      });
      return;
    }
    const root = await findGitRoot(cwd);
    if (!root) {
      this.view.webview.postMessage({
        type: "snapshot",
        error: "Not a git repository.",
        prs: [],
      });
      return;
    }
    try {
      const prs = await listLocalPrs(root);
      const ids = prs.map((p) => p.id);
      const freshIds = this.primed
        ? ids.filter((id) => !this.knownIds.has(id))
        : [];
      this.primed = true;
      for (const id of ids) this.knownIds.add(id);
      if (freshIds.length && !this.userPinned) {
        this.selectedId = freshIds[0];
      }
      if (this.selectedId && !prs.some((p) => p.id === this.selectedId)) {
        this.selectedId = prs[0]?.id;
      }
      if (!this.selectedId) this.selectedId = prs[0]?.id;
      const selected = prs.find((p) => p.id === this.selectedId);
      let files: { status: string; path: string }[] = [];
      let diff = "";
      if (selected) {
        files = await getLocalPrNameStatus(root, selected.id);
        diff = await getLocalPrDiff(root, selected.id, { maxBytes: 60_000 });
      }
      this.view.webview.postMessage({
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
      this.view.webview.postMessage({
        type: "snapshot",
        error: err instanceof Error ? err.message : String(err),
        prs: [],
      });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    body { margin: 0; padding: 8px; }
    h1 { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
    .row { display: flex; gap: 6px; margin-bottom: 8px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 8px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .pr {
      padding: 6px 8px;
      border: 1px solid var(--vscode-widget-border, transparent);
      margin-bottom: 4px;
      cursor: pointer;
    }
    .pr.fresh { outline: 1px solid var(--vscode-focusBorder); }
    .live { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); display: inline-block; margin-right: 6px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    pre {
      white-space: pre-wrap;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      overflow: auto;
      max-height: 240px;
      font-size: 11px;
    }
    textarea { width: 100%; box-sizing: border-box; min-height: 48px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
    ul { padding-left: 16px; margin: 6px 0; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="live">
    <h1><span class="dot"></span>Watching</h1>
    <p class="muted" id="meta"></p>
  </div>
  <p class="muted" id="tagline">Packets land here as agents finish. GitHub when you say so.</p>
  <div class="row">
    <button id="create">Create</button>
    <button class="secondary" id="refresh">Refresh</button>
    <button class="secondary" id="gitlens">Open in GitLens</button>
  </div>
  <div id="list"></div>
  <div id="detail"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");
    const detail = document.getElementById("detail");
    document.getElementById("create").onclick = () => vscode.postMessage({ type: "create" });
    document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
    document.getElementById("gitlens").onclick = () => vscode.postMessage({ type: "openGitLens" });
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "snapshot") return;
      if (msg.error) {
        list.innerHTML = '<p class="error"></p>';
        list.firstChild.textContent = msg.error;
        detail.innerHTML = "";
        return;
      }
      const prs = msg.prs || [];
      const fresh = new Set(msg.freshIds || []);
      const meta = document.getElementById("meta");
      meta.textContent = (msg.repo ? msg.repo + " · " : "") + prs.length + " packet" + (prs.length === 1 ? "" : "s");
      list.innerHTML = "";
      if (!prs.length) {
        list.innerHTML = '<p class="muted">Waiting for agents. When a subagent commits work, a draft packet appears here.</p>';
      }
      for (const pr of prs) {
        const el = document.createElement("div");
        el.className = "pr" + (pr.id === msg.selectedId ? " active" : "") + (fresh.has(pr.id) ? " fresh" : "");
        el.innerHTML = '<div class="status"></div><div></div><div class="muted"></div>';
        el.children[0].textContent = pr.status.replace("_", " ");
        el.children[1].textContent = pr.title;
        const src = pr.source && pr.source.kind === "subagent"
          ? (pr.source.subagentType || "subagent")
          : (pr.source && pr.source.kind) || "local";
        el.children[2].textContent = src + " · " + pr.headRef + " → " + pr.baseRef;
        el.onclick = () => vscode.postMessage({ type: "select", id: pr.id });
        list.appendChild(el);
      }
      const selected = prs.find((p) => p.id === msg.selectedId);
      if (!selected) { detail.innerHTML = ""; return; }
      const files = (msg.files || []).map((f) => {
        const li = document.createElement("li");
        li.textContent = f.status + " " + f.path;
        return li.outerHTML;
      }).join("");
      detail.innerHTML = [
        "<h1>Packet</h1>",
        "<p class='muted'></p>",
        "<div class='row'>",
        "<button data-s='ready'>Ready</button>",
        "<button data-s='approved'>Approve</button>",
        "<button class='secondary' data-s='changes_requested'>Request changes</button>",
        "<button class='secondary' id='openWt'>Open worktree</button>",
        "</div>",
        "<ul>" + files + "</ul>",
        "<pre></pre>",
        "<textarea id='cmt' placeholder='Local review comment'></textarea>",
        "<div class='row'><button id='send'>Comment</button></div>"
      ].join("");
      detail.querySelector("p").textContent = selected.id + (selected.worktreePath ? "" : " · worktree gone, refs remain");
      detail.querySelector("pre").textContent = msg.diff || "(no diff)";
      for (const btn of detail.querySelectorAll("button[data-s]")) {
        btn.onclick = () => vscode.postMessage({ type: "status", id: selected.id, status: btn.getAttribute("data-s") });
      }
      detail.querySelector("#openWt").onclick = () => vscode.postMessage({ type: "openFolder", id: selected.id });
      detail.querySelector("#send").onclick = () => {
        const body = detail.querySelector("#cmt").value;
        if (body.trim()) vscode.postMessage({ type: "comment", id: selected.id, body });
      };
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
