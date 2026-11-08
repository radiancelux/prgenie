import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __PRGENIE_RUNNER_VERSION__: string | undefined;

/** Package version for `prgenie --version` (bundled define in production builds). */
export function runnerCliVersion(): string {
  if (typeof __PRGENIE_RUNNER_VERSION__ === "string" && __PRGENIE_RUNNER_VERSION__) {
    return __PRGENIE_RUNNER_VERSION__;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const pkg = require(path.join(here, "..", "package.json")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* dev / test without package adjacent */
  }
  return "0.0.0-dev";
}
