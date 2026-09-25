# PR Genie Cursor agents

Shipped agent definitions for steward-spawned Tasks. Vendor model ids live **only** in these files (or a documented override under `~/.cursor/agents/` after `pnpm link-plugin`).

| File                            | Tier   | Role                                                                |
| ------------------------------- | ------ | ------------------------------------------------------------------- |
| `prgenie-implementor.md`        | cheap  | Default implementor                                                 |
| `prgenie-implementor-strong.md` | strong | Explicit `tier: strong` marker or same AC open after two rejections |
| `prgenie-reviewer.md`           | strong | Reviewer leaf                                                       |

`pnpm link-plugin` copies `packages/plugin/agents/prgenie-*.md` into `%USERPROFILE%\.cursor\agents\`. Bracket options on `model:` (e.g. `[fast=false]`) are ignored by Cursor 3.22.7+ — use bare slugs such as `composer-2.5` or `inherit`.
