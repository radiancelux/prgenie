import { readFileSync } from "node:fs";
import {
  findGitRoot,
  findLocalPrForCurrentWorktree,
  formatReviewInbox,
  formatSpawnReviewer,
  markReviewRequested,
  markReviewerNotified,
  pendingReviewComments,
  refreshLocalPrHead,
  shouldSpawnReviewer,
} from "@prgenie/core";

type HookInput = Record<string, unknown>;

function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return process.cwd();
}

function eventName(input: HookInput): string {
  return String(input.hook_event_name ?? input.event ?? "");
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

  const event = eventName(input);
  const loopCount = Number(input.loop_count ?? 0);
  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);
  if (!root) {
    silent();
    return;
  }

  const pr = await findLocalPrForCurrentWorktree(root);
  if (!pr) {
    silent();
    return;
  }

  const inbox = formatReviewInbox(pr);

  if (event === "sessionStart") {
    if (!inbox) {
      silent();
      return;
    }
    process.stdout.write(JSON.stringify({ additional_context: inbox }) + "\n");
    return;
  }

  if (event === "subagentStop") {
    if (!inbox || loopCount >= 2) {
      silent();
      return;
    }
    process.stdout.write(JSON.stringify({ followup_message: inbox }) + "\n");
    return;
  }

  if (event === "stop") {
    if (loopCount >= 1) {
      silent();
      return;
    }
    const pending = pendingReviewComments(pr);
    const newest = pending[pending.length - 1];
    if (newest?.role === "human" && inbox) {
      process.stdout.write(JSON.stringify({ followup_message: inbox }) + "\n");
      return;
    }
    if (pr.status === "ready") {
      const fresh = await refreshLocalPrHead(root, pr.id);
      // Drift baseline may lag if HEAD moved while ready.
      if ((fresh.reviewRequestedSha ?? null) !== fresh.headSha) {
        await markReviewRequested(root, fresh.id);
      }
      // Spawn reminder once per HEAD (separate from the drift baseline).
      if (shouldSpawnReviewer(fresh)) {
        await markReviewerNotified(root, fresh.id);
        process.stdout.write(JSON.stringify({ followup_message: formatSpawnReviewer(fresh) }) + "\n");
        return;
      }
    }
    silent();
    return;
  }

  silent();
}

main().catch(() => {
  silent();
});
