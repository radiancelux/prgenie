import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmDir = path.join(root, "packages/npm-prgenie");
const bundle = path.join(npmDir, "runner.cjs");

if (!existsSync(bundle)) {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit", timeout: 300_000 });
}

execFileSync(process.execPath, [path.join(root, "scripts/verify-runner-version.mjs")], {
  stdio: "inherit",
  timeout: 60_000,
});

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: npmDir,
  encoding: "utf8",
  timeout: 60_000,
});
const [pack] = JSON.parse(out);
const names = pack.files.map((f) => f.path);

for (const f of pack.files) console.log(`${String(f.size).padStart(10)}  ${f.path}`);
console.log(`${pack.filename}  ${pack.entryCount} files  ${pack.size} bytes packed`);

const forbidden = /\.(test|spec)\.|(^|\/)src\/|fixtures?\/|\.env\b/i;
const required = [
  "package.json",
  "runner.cjs",
  "markdownlint-prose-defaults.jsonc",
  "README.md",
  "LICENSE",
];
const bad = names.filter((n) => forbidden.test(n));
const missing = required.filter((n) => !names.includes(n));
const failures = [];
if (bad.length) failures.push(`disallowed paths: ${bad.join(", ")}`);
if (missing.length) failures.push(`missing required files: ${missing.join(", ")}`);

const license = readFileSync(path.join(npmDir, "LICENSE"), "utf8");
if (license !== readFileSync(path.join(root, "LICENSE"), "utf8")) {
  failures.push("packages/npm-prgenie/LICENSE differs from the repository LICENSE");
}
if (!/^MIT License\b/.test(license)) failures.push("LICENSE is not the MIT license text");

if (failures.length) {
  for (const f of failures) console.error(`FAIL  npm pack: ${f}`);
  process.exit(1);
}
console.log("ok    npm pack contents look publishable (MIT LICENSE, no tests/fixtures/src).");
