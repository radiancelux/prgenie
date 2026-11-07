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

  it("groups thread Edit/Delete/Resolve in thread-actions with Resolve wording", () => {
    assert.match(laneSrc, /thread-actions/);
    assert.match(
      laneSrc,
      /class="address success"[^>]*title="Implementor: [^"]*resolve[^"]*">Reply &amp; resolve</,
    );
    assert.match(
      laneSrc,
      /class="resolve resolve-btn"[^>]*title="Reviewer: resolve finding">Resolve</,
    );
    assert.doesNotMatch(laneSrc, /Mark addressed/);
    assert.doesNotMatch(laneSrc, />Addressed</);
    // Behavior unchanged: the open-finding button still posts the human-gated "address" action.
    assert.match(laneSrc, /type: "address",/);
  });

  it("injects round collapse state and prunes it on round signature changes", () => {
    assert.match(laneSrc, /\$\{ROUND_STATE_BODY\}/);
    assert.match(
      laneSrc,
      /roundSignature !== lastRoundSignature\) \{\s*pruneRoundState\(selected\.id, rounds\)/,
    );
    assert.match(laneSrc, /data-last/);
    assert.match(laneSrc, /roundCollapsedAfterToggle\(/);
  });

  it("injects CI card view-model render and gate busy reason", () => {
    assert.match(laneSrc, /RENDER_CI_CARD_BODY/);
    assert.match(laneSrc, /formatExportGateBusyReason/);
    assert.match(laneSrc, /ci-card-summary/);
    assert.match(laneSrc, /startedAtMs/);
    assert.match(laneSrc, /normalizeComment/);
  });
});
