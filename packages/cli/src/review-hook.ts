import {
  findGitRoot,
  findLocalPrForCurrentWorktree,
  formatReviewInbox,
  formatSessionReconnectDigest,
  pendingReviewComments,
} from "@prgenie/core";
import { normalizeHookWorkspacePath, parseHookPayloadBuffer, readHookStdin } from "./hook-stdin.js";

type HookInput = Record<string, unknown>;

export function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return normalizeHookWorkspacePath(input.cwd);
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return normalizeHookWorkspacePath(roots[0]);
  }
  return process.cwd();
}

export function eventName(input: HookInput): string {
  return String(input.hook_event_name ?? input.event ?? "");
}

function silent(): void {
  process.stdout.write("{}\n");
}

export async function main(): Promise<void> {
  const { raw } = await readHookStdin();
  const parsed = parseHookPayloadBuffer(raw);
  const input: HookInput = parsed.ok ? parsed.input : {};

  const event = eventName(input);
  const loopCount = Number(input.loop_count ?? 0);
  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);
  if (!root) {
    silent();
    return;
  }

  const pr = await findLocalPrForCurrentWorktree(root);
  const inbox = pr ? formatReviewInbox(pr) : null;

  if (event === "sessionStart") {
    // RAD-97: one reconnect digest reconciling Task ids vs loop status (all live loops).
    const digest = await formatSessionReconnectDigest(root).catch(() => null);
    const parts = [digest, inbox].filter((s): s is string => Boolean(s && s.trim()));
    if (parts.length === 0) {
      silent();
      return;
    }
    process.stdout.write(JSON.stringify({ additional_context: parts.join("\n\n") }) + "\n");
    return;
  }

  if (!pr) {
    silent();
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
    silent();
    return;
  }

  silent();
}
