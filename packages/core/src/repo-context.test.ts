import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  formatImplementorContextBrief,
  loadRepoContextSnapshot,
  parseContextPaths,
} from "./repo-context.js";

test("parseContextPaths lists paths only", () => {
  const paths = parseContextPaths(
    "---\nrequired: false\n---\n\n- CONTRIBUTING.md\n- docs/standards/\n- `.cursor/skills/foo/SKILL.md`\n",
  );
  assert.deepEqual(paths, ["CONTRIBUTING.md", "docs/standards/", ".cursor/skills/foo/SKILL.md"]);
});

test("missing context fails soft", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-context-soft-"));
  try {
    const snap = await loadRepoContextSnapshot(root);
    assert.equal(snap.required, false);
    assert.equal(snap.missing, false);
    assert.equal(formatImplementorContextBrief(snap), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required context with no paths sets missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-context-req-"));
  try {
    await mkdir(path.join(root, ".prgenie"), { recursive: true });
    await writeFile(path.join(root, ".prgenie", "context.md"), "---\nrequired: true\n---\n\n# empty\n");
    const snap = await loadRepoContextSnapshot(root);
    assert.equal(snap.required, true);
    assert.equal(snap.missing, true);
    assert.match(formatImplementorContextBrief(snap) ?? "", /required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context brief lists paths for implementor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-context-paths-"));
  try {
    await mkdir(path.join(root, ".prgenie"), { recursive: true });
    await writeFile(
      path.join(root, ".prgenie", "context.md"),
      "- CONTRIBUTING.md\n- packages/plugin/skills/review/SKILL.md\n",
    );
    const snap = await loadRepoContextSnapshot(root);
    const brief = formatImplementorContextBrief(snap);
    assert.match(brief ?? "", /CONTRIBUTING\.md/);
    assert.match(brief ?? "", /read before implementing/i);
    assert.ok(snap.contentHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CRLF context paths parse on Windows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-context-crlf-"));
  try {
    await mkdir(path.join(root, ".prgenie"), { recursive: true });
    await writeFile(path.join(root, ".prgenie", "context.md"), "- docs\\guide.md\r\n");
    const snap = await loadRepoContextSnapshot(root);
    assert.deepEqual(snap.paths, ["docs/guide.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

after(async () => {
  // tmpdirs cleaned per test
});
