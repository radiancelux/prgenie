# Changelog

## 0.1.2 — unreleased

- Publishable `prgenie` npm package with `prgenie` CLI (`mcp`, `serve`, `init`, `doctor`).
- Stdio MCP exposes runner tools (jobs + settings); shared job store lock for concurrent serve/MCP.
- Copy-paste MCP client setup in README; release workflow prepared (publish is manual).
- Every stdio/HTTP MCP reply carries `jsonrpc: "2.0"` and echoes the request id; `ping` is answered, malformed JSON gets a `-32700` parse error, and the stdio server exits once the client closes stdin.
- `continue_job` MCP tool; `prgenie config --client claude-code`; config snippets use the `prgenie-runner` server id.
- MIT `LICENSE` ships in the tarball.
