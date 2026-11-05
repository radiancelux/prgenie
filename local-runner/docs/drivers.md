# Pluggable AI CLI drivers

The local runner spawns an **agent driver** instead of hard-coding `cursor-agent`. Jobs pick a driver via:

1. `driver` on `start_job` / job input
2. `defaultDriver` in `settings.json` (Setup screen)
3. Fallback: `cursor-agent`

## Driver contract

Each driver implements:

| Method                  | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `id`                    | Stable string id (`cursor-agent`, `claude-code`, `local-model`, …)                    |
| `start(runOpts, hooks)` | Spawn CLI; stream lines via `hooks.onLine`; append raw log via `hooks.appendLog`      |
| `steer` (optional)      | Mid-run follow-up; may no-op with a log line (steer queue still applies on next step) |

`runOpts` includes `cwd`, `prompt`, `model`, `logPath`, `dryRun`, `outputFormat`, `signal`, and the configured `DriverEntry` from settings.

Register a new built-in driver in `local-runner/src/drivers/built-in.ts` and add a row to default settings in `settings.ts`. Third-party CLIs only need a new `AgentDriver` object — **do not** fork `job-runner.ts`.

## Built-in drivers

### `cursor-agent` (default)

```text
cursor-agent -p --force --trust --model <model> --output-format stream-json <prompt>
```

Uses `stream-json` for the dashboard transcript parser.

### `claude-code`

```text
claude -p <prompt> --model <model> --output-format stream-json --dangerously-skip-permissions
```

Binary defaults to `claude` (override in Setup). Missing binary → job **failed** with a clear error (serve keeps running).

### `local-model` (Ollama-style)

```text
OLLAMA_HOST=<endpoint> ollama run <model> <prompt>
```

- Default endpoint: `http://127.0.0.1:11434`
- Model name comes from the job’s `model` field or Setup **default model**
- Emits plain text lines (dashboard shows them as agent steps)

## Logs & UI

- `stream-json-log.ts` parses Cursor-style JSON lines; other drivers may emit text — banner lines `--- agent (...)` still delimit turns.
- Token usage aggregation remains best-effort from cursor-agent `stream-json` usage events.

## Settings

Driver entries live in `$PRGENIE_RUNNER_DATA_DIR/settings.json` under `drivers[]` (`id`, `kind`, `binary`, `endpoint`, optional `apiKey`). API keys are masked on `GET /api/settings` (`apiKeyMasked` only).

See also `local-runner/README.md`.
