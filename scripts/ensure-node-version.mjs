#!/usr/bin/env node
/** Fail fast when Node is below package engines (22+). Imported by pnpm test. */
const required = 22;
// Test seam only: lets ensure-node-version.test.mjs exercise the rejection path.
const version = process.env.PRGENIE_TEST_NODE_VERSION || process.version;
const major = Number(version.replace(/^v/, "").split(".")[0]);
if (!Number.isFinite(major) || major < required) {
  process.stderr.write(
    `PR Genie requires Node.js ${required}+ (current: ${version}).\n` +
      `Install Node ${required} (see .nvmrc) and retry.\n`,
  );
  process.exit(1);
}
