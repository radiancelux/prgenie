# GitHub access for PR Genie loops

Loop agents (implementor, reviewer, steward) must not run with your full GitHub account power. A spec that says “create a scratch repo on GitHub” must fail in the client hook, not on GitHub. **RAD-138** is the counterexample: a loop followed its EARS spec and ran `gh repo create`, which created `radiancelux/rad138-utf8-scratch`.

## Recommended setup

1. **Keep your normal `gh auth login`** for interactive work (export, org admin, creating repos). Use that login when _you_ run `/export` or fix account binds.
2. **Mint a fine-grained personal access token (PAT)** limited to **this repository** only:
   - **Contents** — Read and write
   - **Pull requests** — Read and write
   - **Workflows** — Read and write
   - **Actions** — Read-only
   - Expiration — **90 days or less** (rotate on a calendar reminder)
3. Export it for loop sessions only:

   ```bash
   export GH_TOKEN=github_pat_...
   ```

   Cursor loop agents inherit `GH_TOKEN` when the plugin runs `gh` / `git push` prep. Your broad OAuth login stays in the keyring for human export.

Fine-grained tokens cannot create or delete repositories or change org settings, which matches what loops need: commits, PRs, and CI on the working repo.

## Rotate the token

1. GitHub → **Settings → Developer settings → Fine-grained tokens** → select the PR Genie token → **Regenerate** (or create a new token and delete the old one).
2. Update `GH_TOKEN` in your shell profile or Cursor env and restart Cursor so hook/MCP processes pick it up.
3. Run `prgenie doctor` and confirm **gh-token-scopes** is green.

## OAuth apps and passwords

Changing your GitHub password does **not** revoke OAuth apps or classic tokens already issued to `gh`. After a credential incident, revoke stale **OAuth authorizations** and **personal access tokens** under GitHub settings, then `gh auth login` again for your human login.

## What the hook blocks

The github-gate hook treats a shell command as a loop agent's when it comes from a PR Genie subagent, from a `.loops/<id>` worktree, or from the primary checkout while a live loop has a steward binding. For those it denies:

- repo administration: `gh repo create/delete/edit/rename/archive/unarchive/fork`;
- mutating `gh api` calls (explicit `-X`/`--method`, or implied POST from `-f`/`-F`/`--field`/`--raw-field`/`--input`, attached or not) against `user/repos`, `orgs/*/repos`, `repos/{owner}/{repo}` and its `transfer`/`forks`/`generate` endpoints, plus GraphQL repo lifecycle mutations;
- `gh auth` (except `gh auth status` without `--show-token`), `gh secret`, `gh variable`, `gh ssh-key`, `gh gpg-key`;
- `gh alias set/import/delete` and `gh extension install/upgrade/exec`, which could rename or wrap a denied command;
- force-push (`--force`, `-f`, `--force-with-lease[=…]`, `--force-if-includes`, `--mirror`, or a `+` refspec) whose destination is the default branch or `main`, and deleting the default branch. Other force-pushes still ask, like every `git push`.

The command is tokenized (POSIX and PowerShell quoting), so chains, pipes, `(…)`/`{…}` groups, `$(…)` and backtick substitutions, and `bash -c` / `pwsh -Command` / `eval` / `iex` arguments are each checked. A command word that is only known at run time (`$GH`, `$(…)`) is treated as `gh`/`git`.

The hook is a guard rail, not a sandbox: a determined agent can still reach GitHub through a script file, another program, or a pre-existing alias. The fine-grained `GH_TOKEN` above is the real boundary. See **RAD-163** and `packages/cli/src/loop-github-gate.ts`.

## Doctor

`prgenie doctor` warns when `gh auth status` shows classic scopes such as `repo`, `delete_repo`, `admin:*`, or `workflow` on the active token — scopes broader than loops need. Point the fix at this document and switch loop work to `GH_TOKEN`.
