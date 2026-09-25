import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STATUS_PANEL_TITLE,
  exportBusyHelper,
  statusPanelGuidanceForLoop,
  statusPanelIdleBody,
} from "./statusPanel.js";

describe("STATUS panel copy (RAD-110)", () => {
  it("renames the section to STATUS", () => {
    assert.equal(STATUS_PANEL_TITLE, "STATUS");
  });

  it("clears idle body without leftover READY/FAIL gate language", () => {
    assert.match(statusPanelIdleBody({}), /No loops yet/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /Expand Archive/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /Clear archived/);
    assert.match(statusPanelIdleBody({ archivedCount: 2 }), /remotes stay/i);
    assert.match(statusPanelIdleBody({ searchQuery: "foo" }), /No matching loops/);
    assert.equal(/READY|FAIL|BLOCKED/.test(statusPanelIdleBody({ archivedCount: 1 })), false);
  });

  it("gives phase-correct draft/ready guidance, not export-blocked copy", () => {
    const draft = statusPanelGuidanceForLoop("draft");
    assert.equal(draft.badge, "DRAFT");
    assert.match(draft.body, /Not ready for review/i);
    assert.equal(/EXPORT BLOCKED|FAIL/.test(draft.body), false);

    const ready = statusPanelGuidanceForLoop("ready");
    assert.equal(ready.badge, "READY");
    assert.match(ready.body, /not an export gate/i);

    const archived = statusPanelGuidanceForLoop("approved");
    assert.equal(archived.badge, "ARCHIVED");
    assert.match(archived.body, /Read-only/i);
  });
});

describe("export busy helper (RAD-124)", () => {
  it("names the active step when Open on GitHub is disabled", () => {
    assert.equal(exportBusyHelper("Pushing"), "Open on GitHub unavailable — Pushing");
    assert.match(exportBusyHelper(undefined), /export in progress/);
  });
});
