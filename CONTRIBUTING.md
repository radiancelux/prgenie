# Contributing to PR Genie

Thanks for helping improve PR Genie. This is a pnpm monorepo: shared libraries, a Cursor plugin/extension, CLI, and an optional `local-runner` package.

## Prerequisites

- **Node.js 22+** (see root `package.json` `engines`)
- **pnpm 10+** (`corepack enable` or install pnpm)
- **git** and **GitHub CLI (`gh`)** for export/runner workflows
- **Cursor** (plugin + extension dev) when working on editor integration

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Generated plugin artifacts (`packages/plugin/mcp/server.cjs`, hook bundles) are produced by `pnpm build` and are not committed.

On Windows, use `pnpm link-plugin` and `pnpm link-extension` (PowerShell) to copy the plugin and extension into Cursor. On Linux, point Cursor at the built plugin manually or run integration tests without linking.

## Checks

| Command               | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `pnpm test`           | Node test runner across packages and `local-runner` |
| `pnpm lint`           | ESLint on core, CLI, extension, scripts             |
| `pnpm typecheck`      | TypeScript noEmit for packages + runner             |
| `pnpm format:check`   | Prettier                                            |
| `pnpm check-versions` | Monorepo version alignment                          |

CI runs the same checks on pull requests.

## Pull request flow

1. Fork and create a branch from `main`.
2. Keep changes focused; avoid unrelated refactors.
3. Run `pnpm test`, `pnpm lint`, and `pnpm format:check` before pushing.
4. Open a PR with a clear summary and test plan.
5. Use the PR template checklist.

For architecture changes, add or update an [ADR](docs/decisions/README.md).

## Security and conduct

- Report vulnerabilities via [GitHub Security Advisories](https://github.com/radiancelux/prgenie/security/advisories) (see [SECURITY.md](SECURITY.md)).
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions

Open a [GitHub discussion or issue](https://github.com/radiancelux/prgenie/issues) for design questions. README rewrite and broader docs are tracked in issue #114.
