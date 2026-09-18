import { readFileSync } from "node:fs";
import {
  claimReview,
  findGitRoot,
  findLocalPrForCurrentWorktree,
  formatReviewInbox,
  formatSpawnReviewer,
  getStewardBinding,
  markReviewRequested,
  markReviewerNotified,
  pendingReviewComments,
  refreshLocalPrHead,
  shouldEmitLegacyReviewerHandoff,
} from "@prgenie/core";

type HookInput = Record<string, unknown>;

export function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return process.cwd();
}

export function eventName(input: HookInput): string {
  return String(input.hook_event_name ?? input.event ?? "");
}

function silent(): void {
  process.stdout.write("{}\n");
}

/**
 * Transitional implementor-stop reviewer handoff.
 * Steward-owned loops stay silent (no claim, no spawn prompt).
 */
export async function runStopReviewerHandoff(cwd: string, id: string): Promise<string | null> {
  const fresh = await refreshLocalPrHead(cwd, id);
  if (fresh.status !== "ready") return null;
  if ((fresh.reviewRequestedSha ?? null) !== fresh.headSha) {
    await markReviewRequested(cwd, fresh.id);
  }
  const binding = await getStewardBinding(cwd, fresh.id);
  if (!shouldEmitLegacyReviewerHandoff(fresh, binding)) return null;
  const claimed = await claimReview(cwd, fresh.id, {
    headSha: fresh.headSha,
    source: "hook",
  });
  if (!claimed.claimed) return null;
  await markReviewerNotified(cwd, fresh.id);
  return formatSpawnReviewer(fresh);
}

export async function main(): Promise<void> {
  let input: HookInput;
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
      const followup = await runStopReviewerHandoff(root, pr.id);
      if (followup) {
        process.stdout.write(JSON.stringify({ followup_message: followup }) + "\n");
        return;
      }
    }
    silent();
    return;
  }

  silent();
}
