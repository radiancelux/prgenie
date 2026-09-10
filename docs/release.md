# Release discipline

Keep **one** version across the monorepo and any local VSIX you pack. `prgenie doctor` and `pnpm check-versions` fail when they drift.

## Version source of truth

These files must share the same `version` string:

- `package.json` (workspace root)
- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/extension/package.json`
- `packages/plugin/package.json`

The extension package version is also what `doctor`'s `extension` check compares against the install under `~/.cursor/extensions`.

## Day-to-day (dev)

```powershell
pnpm build
pnpm link-extension   # copies package.json + dist into ~/.cursor/extensions/prgenie.prgenie-<version>
# quit Cursor fully and reopen
prgenie doctor
```

You do **not** need a VSIX for local Cursor installs — `link-extension` is enough.

## Packing a VSIX

`*.vsix` is gitignored on purpose (a checked-in artifact was how versions skewed before). Pack on demand after versions are aligned:

```powershell
# 1. Bump every package.json listed above to the same version (e.g. 0.1.2)
# 2. Build
pnpm build
# 3. Verify alignment (also runs in CI)
pnpm check-versions
# 4. Pack packages/extension/prgenie-<version>.vsix (removes any stale prgenie-*.vsix first)
pnpm pack:extension
# 5. Optional: install from the VSIX, or attach it to a GitHub Release
```

`pnpm pack:extension` names the file from `packages/extension/package.json` and embeds that same `package.json`, so doctor `package-versions` stays green when a local VSIX is present.

## Doctor checks

| id                 | What it catches                                      |
| ------------------ | ---------------------------------------------------- |
| `package-versions` | Monorepo `package.json` skew and lagging local VSIX  |
| `extension`        | Installed sidebar extension ≠ extension package.json |

## See also

- [Troubleshooting](troubleshooting.md) — stale extension / plugin recovery
- [Architecture](architecture.md) — packages and install paths
