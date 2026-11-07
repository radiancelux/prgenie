import { main } from "./github-hook.js";
import { gateCrashPayload } from "./hook-stdin.js";

// Always run: this file is the esbuild entry for packages/plugin/hooks/github-gate.cjs.
// Do not gate on import.meta.url - esbuild CJS blanks it to {} and would fail-open.
// A crash (bad input, stack overflow) fails closed: deny unless the human set the ask flag .
let answered = false;
const failClosed = (): void => {
  if (answered) return;
  answered = true;
  process.stdout.write(JSON.stringify(gateCrashPayload()));
};
process.on("uncaughtException", failClosed);
main().then(() => {
  answered = true;
}, failClosed);
