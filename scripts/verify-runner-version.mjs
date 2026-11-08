// Fails when packages/npm-prgenie/runner.cjs reports a different version than
// packages/npm-prgenie/package.json (guards against publishing a stale bundle).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmDir = path.join(root, "packages/npm-prgenie");
const expected = JSON.parse(readFileSync(path.join(npmDir, "package.json"), "utf8")).version;
const actual = execFileSync(process.execPath, [path.join(npmDir, "runner.cjs"), "--version"], {
  encoding: "utf8",
  timeout: 60_000,
}).trim();

if (actual !== expected) {
  console.error(
    `FAIL  runner.cjs --version is ${JSON.stringify(actual)} but package.json is ${expected}. Rebuild with \`pnpm build\`.`,
  );
  process.exit(1);
}
console.log(`ok    runner.cjs --version matches package.json (${expected}).`);
