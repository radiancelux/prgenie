import { access } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { git, type LocalPr } from "@prgenie/core";

export const REV_SCHEME = "prgenie-rev";

type GitAPI = {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
};

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    if (q.get("empty") === "1") return "";
    const root = q.get("root");
    const sha = q.get("sha");
    if (!root || !sha) return "";
    const file = uri.path.replace(/^\//, "");
    const result = await git(root, ["show", `${sha}:${file}`], { allowFail: true });
    return result.code === 0 ? result.stdout : "";
  }
}

function revUri(root: string, sha: string, filePath: string, empty = false): vscode.Uri {
  const posix = filePath.replace(/\\/g, "/");
  return vscode.Uri.from({
    scheme: REV_SCHEME,
    path: `/${posix}`,
    query: empty
      ? "empty=1"
      : `root=${encodeURIComponent(root)}&sha=${encodeURIComponent(sha)}`,
  });
}

async function gitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(n: number): GitAPI }>("vscode.git");
  if (!ext) return undefined;
  const api = ext.isActive ? ext.exports : await ext.activate();
  try {
    return api.getAPI(1);
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function splitChangePath(
  status: string,
  raw: string,
): { leftPath: string; rightPath: string } {
  if ((status.startsWith("R") || status.startsWith("C")) && raw.includes("\t")) {
    const [leftPath, rightPath] = raw.split("\t");
    return { leftPath, rightPath };
  }
  return { leftPath: raw, rightPath: raw };
}

async function sideUris(
  root: string,
  pr: LocalPr,
  status: string,
  rawPath: string,
): Promise<{ left: vscode.Uri; right: vscode.Uri; title: string }> {
  const { leftPath, rightPath } = splitChangePath(status, rawPath);
  const worktree = pr.worktreePath;
  const rightDisk = worktree ? path.join(worktree, rightPath) : path.join(root, rightPath);
  const leftDisk = worktree ? path.join(worktree, leftPath) : path.join(root, leftPath);
  const probe = vscode.Uri.file(rightDisk);
  const api = await gitApi();
  const deleted = status === "D" || status.startsWith("D");
  const added = status === "A" || status.startsWith("A");

  let left: vscode.Uri;
  let right: vscode.Uri;
  if (api) {
    left = added
      ? revUri(root, pr.baseSha, leftPath, true)
      : api.toGitUri(vscode.Uri.file(leftDisk), pr.baseSha);
    if (deleted) {
      right = revUri(root, pr.headSha, rightPath, true);
    } else if (worktree && (await exists(rightDisk))) {
      right = vscode.Uri.file(rightDisk);
    } else {
      right = api.toGitUri(probe, pr.headSha);
    }
  } else {
    left = revUri(root, pr.baseSha, leftPath, added);
    right =
      !deleted && worktree && (await exists(rightDisk))
        ? vscode.Uri.file(rightDisk)
        : revUri(root, pr.headSha, rightPath, deleted);
  }

  const other = worktree ? "worktree" : pr.headRef;
  return {
    left,
    right,
    title: `${path.basename(rightPath)} (${pr.baseRef} ↔ ${other})`,
  };
}

export async function openFileChange(
  root: string,
  pr: LocalPr,
  status: string,
  rawPath: string,
): Promise<void> {
  const { left, right, title } = await sideUris(root, pr, status, rawPath);
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  });
}

export async function openAllChanges(
  root: string,
  pr: LocalPr,
  files: { status: string; path: string }[],
): Promise<void> {
  if (files.length === 0) {
    void vscode.window.showInformationMessage("No files changed in this loop.");
    return;
  }
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const file of files) {
    const { left, right } = await sideUris(root, pr, file.status, file.path);
    resources.push([left, right, right]);
  }
  const title = `${pr.title} (${pr.baseRef} ↔ ${pr.worktreePath ? "worktree" : pr.headRef})`;
  try {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  } catch {
    await openFileChange(root, pr, files[0].status, files[0].path);
  }
}
