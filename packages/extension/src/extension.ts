import * as vscode from "vscode";
import { LaneViewProvider } from "./laneView.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LaneViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prgenie.lane", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("prgenie.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("prgenie.createPr", () => provider.createPr()),
  );
}

export function deactivate(): void {}
