/** Subcommands that belong to the monorepo / Cursor plugin `prgenie` CLI, not the npm runner. */
export const PLUGIN_CLI_COMMANDS = new Set([
  "create",
  "list",
  "attach",
  "queue",
  "inbox",
  "watch",
  "claim-review",
  "steward",
  "export",
  "shepherd",
  "sessions",
  "update",
  "show",
  "diff",
  "delete",
  "reopen",
  "approve",
  "ready",
  "request-changes",
  "comment",
  "address",
  "resolve",
  "edit-comment",
  "delete-comment",
  "complete-review",
  "status",
  "worktrees",
  "worktree",
  "learnings",
  "disable-learning",
  "enable-learning",
  "delete-learning",
  "preflight",
  "gh",
  "version",
]);

export function unknownRunnerCommandMessage(cmd: string): string {
  if (PLUGIN_CLI_COMMANDS.has(cmd)) {
    return (
      `unknown command: ${cmd} — \`${cmd}\` is a command of the PR Genie plugin/monorepo CLI, not the npm runner. ` +
      `Install from source and use \`pnpm cli ${cmd}\` or \`node packages/cli/dist/prgenie.cjs ${cmd}\` ` +
      `(see https://github.com/radiancelux/prgenie#install-from-source-monorepo-cursor-plugin-extension).`
    );
  }
  return `unknown command: ${cmd}`;
}
