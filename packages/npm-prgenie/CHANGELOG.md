# Changelog

## Unreleased

- Windows: resolve `cursor-agent` `.ps1` installs for doctor and the default driver; shared spawn via `powershell.exe -File` (#184).
- Windows: `init` prints only the PowerShell token override (Git Bash note optional) (#185).
- CLI: next-step hints detect `npx` on npm 7+ (Node 24 / npm 11 `npm exec`), so `npx -y prgenie@latest init` prints `Next: npx -y prgenie@latest doctor` (#186).
- Doctor: per-OS Cursor CLI install commands when `cursor-agent` is missing (#187).
- Dashboard: session-started jobs stay visible when **Show finished** is off (#188).
- Docs: Windows prerequisites with `winget` install steps (#189).

## 0.1.4 — 2026-11-08

- Onboarding docs: npm vs monorepo happy path, contributing split, Node 22+ enforcement (#161, #162, #164, #114).
- Runner CLI: `config --client claude-desktop` with `--global`/`--npx`; Resend notify warnings in dashboard/Setup (#162, #164).
- Windows `init` prints the PowerShell token line; plugin-style commands get monorepo CLI hints (#161, #164).
- Tests reject Node <22 via `ensure-node-version`.

## 0.1.3 — 2026-11-08

- Compute jobs (#167).
- Settings UI exposes the v2 runner policy and cleaner onboarding copy (#145, #163).
- New agent form keeps the prompt file input (#155).
- Job start preflight, failed-worktree cleanup, and dry-run mode (#156–#158).
- CLI polish: clearer `serve` errors, better `doctor`, smoother first run, and next-step hints that use `npx -y prgenie@latest …` when run through npx (#159, #160, #165).

## 0.1.2 — 2026-11-07

- Publishable `prgenie` npm package with `prgenie` CLI (`mcp`, `serve`, `init`, `doctor`).
- Stdio MCP exposes runner tools (jobs + settings); shared job store lock for concurrent serve/MCP.
- Copy-paste MCP client setup in README; release workflow prepared (publish is manual).
- Every stdio/HTTP MCP reply carries `jsonrpc: "2.0"` and echoes the request id; `ping` is answered, malformed JSON gets a `-32700` parse error, and the stdio server exits once the client closes stdin.
- `continue_job` MCP tool; `prgenie config --client claude-code`; config snippets use the `prgenie-runner` server id.
- MIT `LICENSE` ships in the tarball.
