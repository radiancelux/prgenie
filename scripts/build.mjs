import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
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
  entryPoints: ["packages/cli/src/capture-hook.ts"],
  outfile: "packages/plugin/hooks/capture-subagent.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/cli/src/github-hook.ts"],
  outfile: "packages/plugin/hooks/github-gate.cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/extension/src/extension.ts"],
  outfile: "packages/extension/dist/extension.js",
  external: ["vscode"],
});

console.log("PR Genie build complete.");
await esbuild.stop();
process.exit(0);
