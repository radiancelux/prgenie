import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { firstJsonObject, parseJsonObject, writeJsonFile } from "./store.js";

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
