import { readFileSync } from "node:fs";
import { ensureRepoGithub, findGitRoot, getRepoGithubBind } from "@prgenie/core";

type HookInput = Record<string, unknown>;

function isPublish(command: string): boolean {
  return (
    /\bgit(\.exe)?\s+push\b/i.test(command) ||
    /\bgh(\.exe)?\s+pr\s+create\b/i.test(command) ||
    /\bgh(\.exe)?\s+pr\s+merge\b/i.test(command) ||
    /\bgh(\.exe)?\s+repo\s+create\b/i.test(command)
  );
}

function isGithubCli(command: string): boolean {
  return /\bgh(\.exe)?\b/i.test(command) || /\bgit(\.exe)?\s+push\b/i.test(command);
}

function switchUser(command: string): string | null {
  const match = command.match(/\bgh(?:\.exe)?\s+auth\s+switch\b[\s\S]*?--user\s+(\S+)/i);
  return match?.[1] ?? null;
}

async function main(): Promise<void> {
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  const command = String(input.command ?? "");
  const cwd = String(input.cwd ?? process.cwd());
  const root = await findGitRoot(cwd);

  if (root && isGithubCli(command)) {
    const bind = await getRepoGithubBind(root);
    const switchingTo = switchUser(command);
    if (bind && switchingTo && switchingTo.toLowerCase() !== bind.login.toLowerCase()) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie: this repo is bound to GitHub account ${bind.login}. ${switchingTo} is a different login.`,
          agent_message: `This repository is bound to ${bind.login}. Do not gh auth switch to ${switchingTo}. Use prgenie gh use ${bind.login} if the bind should change.`,
        }),
      );
      return;
    }
    try {
      await ensureRepoGithub(root);
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie could not switch to the bound GitHub account: ${err instanceof Error ? err.message : err}`,
          agent_message:
            "Could not switch GitHub accounts. Ask the user to run prgenie gh use <login>.",
        }),
      );
      return;
    }
  }

  if (isPublish(command)) {
    const bind = root ? await getRepoGithubBind(root) : null;
    const asWho = bind ? ` as ${bind.login}` : "";
    process.stdout.write(
      JSON.stringify({
        permission: "ask",
        user_message: `PR Genie: this would publish to GitHub${asWho}. Local PR first, unless you explicitly want to export.`,
        agent_message:
          "Do not git push or gh pr create. Open a local PR with PR Genie, then wait for the user to export.",
      }),
    );
    return;
  }

  process.stdout.write(JSON.stringify({ permission: "allow" }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
});
