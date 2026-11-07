import * as vscode from "vscode";
import { LaneHub } from "./laneView.js";
import { REV_SCHEME, RevisionContentProvider } from "./gitDiff.js";

export function activate(context: vscode.ExtensionContext): void {
  const hub = new LaneHub(context);
  const retain = { webviewOptions: { retainContextWhenHidden: true } };
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.text = "$(git-pull-request) PR Genie";
  statusBar.tooltip = "Show PR Genie Loop panel";
  statusBar.command = "prgenie.openPanel";
  statusBar.show();
  context.subscriptions.push(
    statusBar,
    hub,
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, new RevisionContentProvider()),
    vscode.window.registerWebviewViewProvider("prgenie.lane", hub.provider("lane"), retain),
    vscode.window.registerWebviewViewProvider("prgenie.panel", hub.provider("panel"), retain),
    vscode.commands.registerCommand("prgenie.refresh", () => hub.refresh()),
    vscode.commands.registerCommand("prgenie.createPr", () => hub.createPr()),
    vscode.commands.registerCommand("prgenie.attachPr", () => hub.attachPr()),
    vscode.commands.registerCommand("prgenie.openGitLens", () => hub.openGitLens()),
    vscode.commands.registerCommand("prgenie.openLane", () =>
      vscode.commands.executeCommand("prgenie.lane.focus"),
    ),
    vscode.commands.registerCommand("prgenie.openPanel", () =>
      vscode.commands.executeCommand("prgenie.panel.focus"),
    ),
    vscode.commands.registerCommand("prgenie.switchLoop", () => hub.switchSelected()),
  );
}

export function deactivate(): void {}
