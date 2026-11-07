#!/usr/bin/env node
/**
 * Dry-run smoke: one job through implement → review → fix → approve without cursor-agent or email.
 * Requires: pnpm build, PRGENIE_RUNNER_TOKEN
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const token = process.env.PRGENIE_RUNNER_TOKEN || "smoke-test-token";
const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-smoke-"));
const promptFile = path.join(dataDir, "prompt.md");
await writeFile(promptFile, "Implement  smoke ticket and open a PR.\n", "utf8");

const runner = spawn("node", [path.join(root, "local-runner/dist/runner.cjs"), "serve"], {
  env: {
    ...process.env,
    PRGENIE_RUNNER_TOKEN: token,
    PRGENIE_RUNNER_DATA_DIR: dataDir,
    PRGENIE_RUNNER_DRY_RUN: "1",
    PRGENIE_RUNNER_PORT: "19473",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((r) => setTimeout(r, 800));

const base = "http://127.0.0.1:19473";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const startRes = await fetch(`${base}/mcp`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "start_job",
      arguments: {
        repoPath: root,
        branch: "smoke/issue-315",
        promptFile,
        maxRounds: 2,
        dryRun: true,
      },
    },
  }),
});
const startJson = await startRes.json();
if (startJson.error) {
  runner.kill();
  throw new Error(startJson.error.message);
}
const job = JSON.parse(startJson.result.content[0].text);
const jobId = job.id;

let stage = job.stage;
for (
  let i = 0;
  i < 120 && !["approved", "failed", "stuck", "changes_remaining", "stopped"].includes(stage);
  i++
) {
  await new Promise((r) => setTimeout(r, 500));
  const g = await fetch(`${base}/api/jobs/${jobId}`, { headers });
  const j = await g.json();
  stage = j.stage;
}

runner.kill();

if (stage !== "approved") {
  console.error("Smoke failed: expected approved, got", stage);
  process.exit(1);
}
console.log("Smoke OK: job", jobId, "→", stage);
