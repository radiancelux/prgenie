#!/usr/bin/env node
/** Fail fast when Node is below package engines (22+). Imported by pnpm test. */
const required = 22;
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < required) {
  process.stderr.write(
    `PR Genie requires Node.js ${required}+ (current: ${process.version}).\n` +
      `Install Node ${required} (see .nvmrc) and retry.\n`,
  );
  process.exit(1);
}
