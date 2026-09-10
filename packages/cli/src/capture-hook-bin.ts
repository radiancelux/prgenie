import { main } from "./capture-hook.js";

// Always run: esbuild entry for packages/plugin/hooks/capture-subagent.cjs.
// Do not gate on import.meta.url in CJS bundles.
main().catch(() => {
  process.stdout.write("{}
");
});
