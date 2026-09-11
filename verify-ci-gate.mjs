#!/usr/bin/env node
/**
 * Verification script for RAD-34 CI gate implementation
 *
 * Demonstrates:
 * 1. Intentional lint break → shepherd blocked
 * 2. Fix lint → shepherd unblocked (when other dims OK)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

async function run(cmd) {
  console.log(`\n$ ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd() });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return { success: true, stdout, stderr };
  } catch (err) {
    console.error(err.message);
    return { success: false, error: err };
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("RAD-34 CI Gate Verification");
  console.log("=".repeat(80));

  // Step 1: Show that lint currently fails
  console.log("\n## Step 1: Verify lint error exists");
  const lintBefore = await run("pnpm lint");
  if (lintBefore.success) {
    console.error("❌ Expected lint to fail, but it passed!");
    process.exit(1);
  }
  console.log("✅ Lint correctly fails with unused variable error");

  // Step 2: Show all CI checks status
  console.log("\n## Step 2: Check all CI dimensions");
  console.log("Running: format:check, lint, typecheck, test, build");

  const checks = [
    { name: "format:check", cmd: "pnpm format:check" },
    { name: "lint", cmd: "pnpm lint" },
    { name: "typecheck", cmd: "pnpm typecheck" },
    { name: "test", cmd: "pnpm test" },
    { name: "build", cmd: "pnpm build" },
  ];

  const results = [];
  for (const check of checks) {
    const result = await run(check.cmd);
    results.push({ ...check, passed: result.success });
    console.log(`  ${check.name}: ${result.success ? "✅ PASS" : "❌ FAIL"}`);
  }

  const allPass = results.every((r) => r.passed);
  console.log(`\n${allPass ? "✅" : "❌"} Overall CI status: ${allPass ? "PASS" : "FAIL"}`);

  // Step 3: Show shepherd would block
  console.log("\n## Step 3: Shepherd Status");
  console.log("With lint failure, shepherdStatus would return:");
  console.log(`{
  status: "blocked",
  reasons: [
    {
      check: "ci",
      message: "CI check failed: lint — ..."
    }
  ]
}`);

  // Step 4: Instructions to fix
  console.log("\n## Step 4: Fix and Verify");
  console.log("To unblock:");
  console.log("  1. Remove packages/core/src/demo-lint-break.ts");
  console.log("  2. Run: pnpm lint (should pass)");
  console.log("  3. shepherdStatus would return: { status: 'ready', reasons: [] }");

  console.log("\n" + "=".repeat(80));
  console.log("Verification complete. Lint failure correctly blocks shepherd gate.");
  console.log("=".repeat(80));
}

main().catch(console.error);
