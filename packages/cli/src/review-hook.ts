import { readFileSync } from "node:fs";
import path from "node:path";
import {
  findGitRoot,
  findLocalPrForCurrentBranch,
  formatReviewInbox,
} from "@prgenie/core";

type HookInput = Record<string, unknown>;

function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string") return roots[0];
  if (typeof input.agent_transcript_path === "string") {
    return path.dirname(input.agent_transcript_path);
  }
  return process.cwd();
}

function silent(): void {
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);
  if (!root) {
    silent();
    return;
  }

  const pr = await findLocalPrForCurrentBranch(root);
  if (!pr) {
    silent();
    return;
  }

  const text = formatReviewInbox(pr);
  if (!text) {
    silent();
    return;
  }

  process.stdout.write(JSON.stringify({ additional_context: text }));
}

main().catch(() => {
  silent();
});
