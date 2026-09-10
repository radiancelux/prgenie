import { main } from "./github-hook.js";

// Always run: this file is the esbuild entry for packages/plugin/hooks/github-gate.cjs.
// Do not gate on import.meta.url - esbuild CJS blanks it to {} and would fail-open.
main().catch(() => {
  process.stdout.write(
    JSON.stringify({
      permission: "ask",
      user_message:
        "PR Genie github gate failed unexpectedly. Allow only if you trust this command.",
      agent_message:
        "github-gate crashed. Do not git push or gh pr create/merge. Ask the user, or run prgenie doctor.",
    }),
  );
});
