import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const laneSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "laneView.ts"),
  "utf8",
);
const extSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "extension.ts"),
  "utf8",
);
const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as { contributes?: { commands?: { command: string; title: string }[] } };

describe("loop panel polish (#129)", () => {
  it("exposes Show Panel command and status bar navigation", () => {
    const cmds = pkg.contributes?.commands ?? [];
    assert.ok(cmds.some((c) => c.command === "prgenie.openPanel" && /Show Panel/i.test(c.title)));
    assert.match(extSrc, /createStatusBarItem/);
    assert.match(extSrc, /prgenie\.openPanel/);
  });

  it("uses a single summary scroll surface (no nested .summary overflow)", () => {
    assert.match(laneSrc, /#sum[\s\S]*?max-height: 40vh/);
    assert.equal(/\.summary\s*\{[^}]*overflow:\s*auto/.test(laneSrc), false);
  });

  it("groups thread Edit/Delete/Resolve in thread-actions", () => {
    assert.match(laneSrc, /thread-actions/);
    assert.match(laneSrc, /Mark addressed/);
    assert.match(laneSrc, /Reviewer: resolve finding/);
  });

  it("injects CI card view-model render and gate busy reason", () => {
    assert.match(laneSrc, /RENDER_CI_CARD_BODY/);
    assert.match(laneSrc, /formatExportGateBusyReason/);
    assert.match(laneSrc, /ci-card-summary/);
    assert.match(laneSrc, /startedAtMs/);
    assert.match(laneSrc, /normalizeComment/);
  });
});
