# PR Genie Cursor agents

Shipped agent definitions for steward-spawned Tasks. Vendor model ids live **only** in these files (or a documented override under `~/.cursor/agents/` after `pnpm link-plugin`).

| File                            | Tier   | Role                                                         |
| ------------------------------- | ------ | ------------------------------------------------------------ |
| `prgenie-implementor.md`        | cheap  | Default implementor                                          |
| `prgenie-implementor-strong.md` | strong | Design-heavy AC or same AC open after two implementor rounds |
| `prgenie-reviewer.md`           | strong | Reviewer leaf                                                |

`pnpm link-plugin` copies `*.md` into `%USERPROFILE%\.cursor\agents\` (replacing interim hand-maintained files — RAD-143).
