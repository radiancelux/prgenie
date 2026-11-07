import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });

const runner = path.join(root, "local-runner/dist/runner.cjs");
const css = path.join(root, "local-runner/dist/dashboard.min.css");
assert.ok(existsSync(runner), "runner.cjs missing after build");
assert.ok(existsSync(css), "dashboard.min.css missing after build");
const bundle = readFileSync(runner, "utf8");
assert.ok(bundle.includes("min-h-screen"), "embedded CSS should include Tailwind utilities");
assert.ok(bundle.includes("PR Genie Local Runner"), "dashboard HTML embedded");

console.log("build-test: ok");
