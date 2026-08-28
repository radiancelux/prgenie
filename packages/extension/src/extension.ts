import * as vscode from "vscode";
import { LaneHub } from "./laneView.js";
import { REV_SCHEME, RevisionContentProvider } from "./gitDiff.js";

export function activate(context: vscode.ExtensionContext): void {
  const hub = new LaneHub(context);
  const retain = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    hub,
    vscode.workspace.registerTextDocumentContentProvider(
      REV_SCHEME,
      new RevisionContentProvider(),
    ),
    vscode.window.registerWebviewViewProvider("prgenie.lane", hub.provider("lane"), retain),
    vscode.window.registerWebviewViewProvider("prgenie.panel", hub.provider("panel"), retain),
    vscode.commands.registerCommand("prgenie.refresh", () => hub.refresh()),
    vscode.commands.registerCommand("prgenie.createPr", () => hub.createPr()),
    vscode.commands.registerCommand("prgenie.openGitLens", () => hub.openGitLens()),
    vscode.commands.registerCommand("prgenie.openLane", () =>
      vscode.commands.executeCommand("prgenie.lane.focus"),
    ),
    vscode.commands.registerCommand("prgenie.openPanel", () =>
      vscode.commands.executeCommand("prgenie.panel.focus"),
    ),
  );
}

export function deactivate(): void {}
