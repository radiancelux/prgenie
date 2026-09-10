import { main } from "./review-hook.js";

// Always run: esbuild entry for packages/plugin/hooks/review-inbox.cjs.
// Do not gate on import.meta.url in CJS bundles.
main().catch(() => {
  process.stdout.write("{}\n");
});
