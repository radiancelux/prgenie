import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { firstJsonObject, parseJsonObject, withFileLock, writeJsonFile } from "./store.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-store-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("parseJsonObject recovers leftover bytes after a shorter overwrite", () => {
  const body = { id: "lp-test", status: "approved" };
  const raw = `${JSON.stringify(body, null, 2)}\n7.247Z"\n}`;
  assert.equal(firstJsonObject(raw), JSON.stringify(body, null, 2));
  const parsed = parseJsonObject<typeof body>(raw);
  assert.equal(parsed.id, "lp-test");
  assert.equal(parsed.status, "approved");
});

test("withFileLock rethrows fn errors without retrying the lock loop", async () => {
  const file = path.join(dir, "lock-target.json");
  await writeFile(file, "{}\n", "utf8");
  const started = Date.now();
  await assert.rejects(
    () =>
      withFileLock(file, async () => {
        throw new Error("HEAD moved since Review requested");
      }),
    /HEAD moved/,
  );
  assert.ok(Date.now() - started < 2000, "expected immediate rethrow, not lock backoff");
});

test("writeJsonFile truncates leftover bytes from a previous longer file", async () => {
  const file = path.join(dir, "pr.json");
  await writeFile(
    file,
    `${JSON.stringify({ status: "changes_requested", extra: "pad-pad-pad" }, null, 2)}\n`,
    "utf8",
  );
  await writeJsonFile(file, { status: "approved" });
  const raw = await readFile(file, "utf8");
  JSON.parse(raw);
  assert.equal(raw.includes("changes_requested"), false);
  assert.equal(raw.includes("pad-pad-pad"), false);
});
