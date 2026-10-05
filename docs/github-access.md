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

From loop worktrees and PR Genie subagents, the github-gate hook denies repo administration (`gh repo create/delete/...`), mutating `gh api` calls against repo lifecycle endpoints, `gh auth` (except `gh auth status`), secrets/variables/keys, and force-push to the default branch. See **RAD-163** and `packages/cli/src/loop-github-gate.ts`.

## Doctor

`prgenie doctor` warns when `gh auth status` shows classic scopes such as `repo`, `delete_repo`, `admin:*`, or `workflow` on the active token — scopes broader than loops need. Point the fix at this document and switch loop work to `GH_TOKEN`.
