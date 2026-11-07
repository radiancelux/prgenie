import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmDir = path.join(root, "packages/npm-prgenie");
const bundle = path.join(npmDir, "runner.cjs");

if (!existsSync(bundle)) {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit", timeout: 300_000 });
}

const out = execFileSync("npm", ["pack", "--dry-run"], {
  cwd: npmDir,
  encoding: "utf8",
  timeout: 60_000,
});

const forbidden = /\.(test|spec)\.|\/src\/|fixtures?\/|\.env\b/i;
const lines = out.split("\n");
const bad = [];
for (const line of lines) {
  const m = line.match(/^\s+[\d.]+\s+([\w./-]+)/);
  if (!m) continue;
  const name = m[1];
  if (forbidden.test(name)) bad.push(name);
}

console.log(out.trim());
if (bad.length) {
  console.error(`FAIL  npm pack would ship disallowed paths: ${bad.join(", ")}`);
  process.exit(1);
}
console.log("ok    npm pack contents look publishable (no tests/fixtures/src).");
