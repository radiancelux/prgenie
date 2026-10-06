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

The command is tokenized (POSIX and PowerShell quoting), so chains, pipes, `(…)`/`{…}` groups, `$(…)` and backtick substitutions, and `<(…)` process substitutions are each checked. Flags before a subcommand (`gh auth -h github.com token`) are skipped the way gh's own lookup skips them.

Heredoc and here-string bodies are data (only `$(…)` inside an unquoted body is checked), so a commit message that mentions `gh repo create` is not denied.

### Scripts run by a shell or evaluator

The runners are `bash`/`sh`/`zsh`/`dash`/`ksh`/`fish`, `pwsh`/`powershell`, `cmd`, `eval`, `iex`/`Invoke-Expression`, and `source`/`.`. A script they run is checked as commands when its text is in the command:

- an argument: `bash -c '…'`, `pwsh -Command '…'`, `cmd /c …`, `eval '…'`, `iex '…'`;
- stdin: a heredoc, `<<<` or here-string (`bash <<'EOF'`, `bash -s`, `pwsh -Command -`, `pwsh -`), or text piped from `echo`, `Write-Output`, a plain `printf` (no `%` or `\`), a single quoted string (`'…' | iex`), or `cat <<'EOF'`;
- a process substitution of those emitters: `bash <(echo '…')`, `source <(echo '…')`.

Loop agents are denied when a runner's script is not in the command text:

- a variable or expansion: `bash -c "$CMD"`, `eval "$CMD"`, `iex $cmd`, `iex @args`, `source "$f"`, `. $env:X`, `cmd /c %CMD%`, `bash <<< "$CMD"`, `echo "$CMD" | bash`, `$x | iex`, `$'…'`;
- command output or a subexpression: `bash -c "$(curl …)"`, `eval $(…)`, `Invoke-Expression (Get-Content x -Raw)`, `pwsh -Command (…)`, `curl … | sh`, `Get-Content x | iex`, `( … ) | iex`, `'a'+'b' | iex`;
- a file or process substitution: `bash < file`, `cat file | bash`, `bash <(curl …)`, `source <(cat x)`, and a script-file argument that is a variable (`bash "$SCRIPT"`);
- escapes or formatting that would have to be decoded: `printf` with `%` or `\` in the format, `echo -e`, any `\` in echoed text, PowerShell backtick escapes, and an unquoted heredoc containing `$` or backticks;
- `pwsh`/`powershell -EncodedCommand` (`-enc`, `-ec`, `-e`), always.

Static script files (`bash script.sh`, `pwsh -File x.ps1`, `source ./env.sh`) are allowed; the hook does not read files.

The same rules apply to a runner behind a prefix command, after its options, option values (separate, attached like `-ux`, or after a short cluster like `-iu x`) and leading operands are skipped: `sudo`, `doas`, `runuser`, `env` (including `VAR=x`), `nice`, `timeout <duration>`, `stdbuf`, `ionice`, `chrt <priority>`, `taskset <mask>`, `command`, `exec`, `nohup`, `time`, `&` and `wsl` (for example `timeout 60 nice -n 5 sudo -u x bash -c "$CMD"` is denied, and `timeout 60 git status` is not).

A runner started by a launcher is checked too:

- `xargs` / `parallel`: the input (stdin, or `parallel`'s `:::` / `::::` / `:::+` arguments) is appended to the runner's arguments, so the runner is denied when it has no script of its own (`xargs bash -c`, `xargs sh`, `xargs eval`, `parallel bash -c ::: "$CMD"`), when its script contains the replace string (`xargs -I{} sh -c '{}'`), or when the input would land in the script text (`xargs pwsh -Command`, `xargs cmd /c`). A literal `xargs bash -c '…' _` is checked like `bash -c '…'`;
- `find -exec` / `-execdir` / `-ok` / `-okdir`: denied when the runner's script contains `{}` or is missing (`-exec sh -c 'run {}' \;`, `-exec bash {} \;`); a literal script is checked;
- `Start-Process` / `saps` / `start`: denied when the program is only known at run time or a runner's `-ArgumentList` contains a variable, subexpression or splat; a literal argument list is checked as one command (`Start-Process bash -ArgumentList '-c','…'`).

Other commands that run under these launchers (`xargs rm`, `find … -exec grep … {} +`, `Start-Process notepad`) are unaffected.

Loop agents must spell `gh` commands literally. A command word that is only known at run time (`$GH`, `$(…)`) is treated as `gh`/`git`. A `gh` command group or subcommand built at run time (`gh $SUB create`, `gh $(echo repo) delete`, `& gh @(…)`), `gh` launched through `xargs` or `Start-Process`, a `gh api` method or endpoint from a variable, and a GraphQL query read from a file (`query=@file`, `--input`) are all denied.

The primary folder counts as a steward context when `stewards.json` names a live loop. If that file exists but can't be read, the hook fails closed and gates the primary folder.

The hook is a guard rail, not a sandbox. The fine-grained `GH_TOKEN` above is the real boundary. Known limits — run-time evaluation the hook cannot see:

- script files are not read: an agent can write `gh repo delete` into a file and run `bash x.sh`, `pwsh -File x.ps1`, `source x`, `node x.js` or `python x.py`;
- other interpreters and programs are not modelled (`python -c`, `node -e`, `perl -e`, `ruby -e`, `make`, package scripts, git hooks and aliases, `curl` to the REST API with the token);
- launchers and prefixes not listed above (for example `su -c`, `runuser -c`, `env -S`, `script -c`, `watch`, `Invoke-Command`, `Start-Job`, `ssh`, `docker exec`, `cmd /c start`) are not unwrapped;
- a pre-existing gh alias or extension, or a `gh` shim earlier on `PATH`, runs under a harmless-looking name;
- shell features outside the tokenizer (functions or aliases defined earlier in the session, `IFS` tricks, unusual quoting) can hide a command.

See **RAD-163** and `packages/cli/src/loop-github-gate.ts`.

## Doctor

`prgenie doctor` warns when `gh auth status` shows classic scopes such as `repo`, `delete_repo`, `admin:*`, or `workflow` on the active token — scopes broader than loops need. Point the fix at this document and switch loop work to `GH_TOKEN`.
