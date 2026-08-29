import { readFileSync } from "node:fs";
import { appendSession, captureAgentWork, findGitRoot } from "@prgenie/core";

type HookInput = Record<string, unknown>;

function inferCwd(input: HookInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
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

  const status = String(input.status ?? "completed");
  const subagentType = String(input.subagent_type ?? "");
  const task = String(input.task ?? input.description ?? "Subagent work");
  const modified = Array.isArray(input.modified_files)
    ? (input.modified_files as string[])
    : [];
  const loopCount = Number(input.loop_count ?? 0);
  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);

  if (root) {
    await appendSession(root, {
      hook: "subagentStop",
      subagent_type: subagentType,
      status,
      task,
      modified_files: modified,
    });
  }

  if (status === "aborted") {
    silent();
    return;
  }

  const readOnly = subagentType === "explore" || subagentType === "shell";
  if (readOnly && modified.length === 0) {
    silent();
    return;
  }

  if (!root) {
    silent();
    return;
  }

  const result = await captureAgentWork(root, {
    title: task.slice(0, 120),
    body: typeof input.summary === "string" ? input.summary : "",
    source: {
      kind: "subagent",
      subagentType,
      subagentId:
        typeof input.subagent_id === "string" ? input.subagent_id : undefined,
      task,
    },
  });

  if (result.action === "skipped") {
    if (modified.length > 0 && loopCount === 0) {
      process.stdout.write(
        JSON.stringify({
          followup_message:
            "PR Genie: the subagent changed files but did not commit. Commit on the current branch if this should become a local PR. Do not git push.",
        }) + "\n",
      );
      return;
    }
    silent();
    return;
  }

  const pr = result.pr;
  if (!pr) {
    silent();
    return;
  }

  process.stdout.write(
    JSON.stringify({
      followup_message: `PR Genie ${result.action} local PR ${pr.id} (${pr.status}) on ${pr.headRef}. It is on the developer's watch list. Do not git push or gh pr create.`,
    }) + "\n",
  );
}

main().catch(() => {
  silent();
});
