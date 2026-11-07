import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(path.join(root, "packages/cli/dist"), { recursive: true });
mkdirSync(path.join(root, "packages/plugin/mcp"), { recursive: true });
mkdirSync(path.join(root, "packages/extension/dist"), { recursive: true });

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "info",
  // Load workspace prettier at runtime — bundling it breaks format:check blob API on Windows.
  external: ["prettier"],
  alias: {
    "@prgenie/core": path.join(root, "packages/core/src/index.ts"),
  },
};

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/bin.ts"],
  outfile: "packages/cli/dist/prgenie.cjs",
  banner: { js: "#!/usr/bin/env node\n" },
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/mcp-bin.ts"],
  outfile: "packages/plugin/mcp/server.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/capture-hook-bin.ts"],
  outfile: "packages/plugin/hooks/capture-subagent.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/github-hook-bin.ts"],
  outfile: "packages/plugin/hooks/github-gate.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/review-hook-bin.ts"],
  outfile: "packages/plugin/hooks/review-inbox.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/extension/src/extension.ts"],
  outfile: "packages/extension/dist/extension.js",
  external: ["vscode", "prettier"],
});

mkdirSync(path.join(root, "local-runner/dist"), { recursive: true });

const dashboardCssIn = path.join(root, "local-runner/src/dashboard.css");
const dashboardCssOut = path.join(root, "local-runner/dist/dashboard.min.css");
const tailwindBin = path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs");
execFileSync(
  process.execPath,
  [tailwindBin, "-i", dashboardCssIn, "-o", dashboardCssOut, "--minify"],
  { cwd: root, stdio: "inherit" },
);
const dashboardCss = readFileSync(dashboardCssOut, "utf8");
copyFileSync(
  path.join(root, "local-runner/markdownlint-prose-defaults.jsonc"),
  path.join(root, "local-runner/dist/markdownlint-prose-defaults.jsonc"),
);

await esbuild.build({
  ...shared,
  entryPoints: ["local-runner/src/bin.ts"],
  outfile: "local-runner/dist/runner.cjs",
  banner: { js: "#!/usr/bin/env node\n" },
  define: {
    __DASHBOARD_CSS__: JSON.stringify(dashboardCss),
  },
});

console.log("PR Genie build complete.");
await esbuild.stop();
process.exit(0);
