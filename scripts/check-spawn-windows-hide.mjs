#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "local-runner", "src");

const SKIP = new Set([
  path.join(root, "spawn-options.ts"),
  path.join(root, "spawn-options.test.ts"),
]);

const SPAWN_RE = /(?:^|[^\w.])(spawn|execFile|exec)\s*\(/g;
const HAS_HIDE_RE = /windowsHide\s*:\s*true|childProcessSpawnOptions\s*\(/;
const ALLOW_COMMENT = /no-windows-hide|test only/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const offenders = [];
for (const file of walk(root)) {
  if (SKIP.has(file)) continue;
  const src = readFileSync(file, "utf8");
  const lines = src.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimStart();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/**")) continue;
    if (/\/\*|^\s*\*/.test(raw)) continue;
    if (!SPAWN_RE.test(line)) {
      SPAWN_RE.lastIndex = 0;
      continue;
    }
    SPAWN_RE.lastIndex = 0;
    const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
    if (ALLOW_COMMENT.test(window)) continue;
    if (!HAS_HIDE_RE.test(window)) {
      offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (offenders.length) {
  console.error("spawn/exec calls missing windowsHide in local-runner/src:\n");
  for (const o of offenders) console.error(o);
  process.exit(1);
}

console.log("spawn windowsHide check ok");
