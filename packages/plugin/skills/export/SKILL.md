---
name: export
description: Open a GitHub pull request at origin from a PR Genie local PR. Use only when the developer explicitly wants to publish — /export, Open on GitHub, or asks to push this loop.
disable-model-invocation: true
---

# Export local PR to origin

The developer is cutting the GitHub PR. This is the explicit publish step.

1. Resolve id: the one they named, else the current branch loop (`list_local_prs`).
2. **You (the human) publish** — agents must not call MCP `export_local_pr` (the hook denies it). Tell the developer to use **Open on GitHub** on the loop panel when status is `reviewed` **and** the export gate is **ready** (RAD-71: shepherd CI green), or run `prgenie export <id>` in a terminal. A steward must not offer export until `steward_next` returns `handoff_human`. **Open on GitHub anyway** when `ready` if they are signing off themselves. Export `git push`es the loop SHA, `gh pr create`s against the loop base (or **`gh pr edit --body-file`** when the GitHub PR already exists — RAD-150), marks the loop `approved` (archived, not deleted), checks the main workspace off the loop branch onto the loop base, and removes a sibling `../<repo>.loops/<id>` checkout. Export is **refused** when the gate is blocked unless `exportGateOverride` (who/why) is recorded on the packet and the body names who, why, and each skipped check (RAD-144). A plain check name does not count; use a backticked name (`` `test:core` ``) or a `Skipped checks:` line. Human skips the gate should honour are named at ready with MCP `ciSkipChecks`, CLI `--ci-skip-checks test:core,lint` (with `--ci-skip-reason`), or a `CI skipped:` comment that includes a `Skipped checks:` line. Named-only skips carry when the gate plan still includes those checks. A plan that drops a recorded check fail-closes. Record override via `prgenie export-gate-override <id> --who … --why …` (human CLI only — MCP `record_export_gate_override` is agent-denied). Progress reports the gate state export acted on. Body-update failure after push is a partial failure, not silent success. If this window is still on that extra worktree, reopen the primary folder so it can be cleared. Repo must be bound — if unbound, ask which login and tell them to run `prgenie gh use <login>` (not MCP `gh_use`). Do not guess.
3. Return the GitHub PR URL. The loop remains on disk (`get_local_pr` / `prgenie show` / Local PRs **Archive**). It drops off the default list.
4. Do not keep reviewing or implementing on that loop unless they ask.

This command **is** permission to `git push` and `gh pr create` for that loop only.
