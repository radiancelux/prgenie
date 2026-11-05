import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideDraftReadyPromotion, type DraftReadyState } from "./draft-pr.js";

function base(partial: Partial<DraftReadyState> = {}): DraftReadyState {
  return {
    stage: "approved",
    lastVerdict: "APPROVE",
    ciStatus: { status: "success", checkedAt: "", source: "github" },
    approveHeadSha: "abc",
    currentHeadSha: "abc",
    isDraft: true,
    readyPromotedAt: null,
    ...partial,
  };
}

describe("decideDraftReadyPromotion", () => {
  it("promotes on APPROVE + green CI + matching head", () => {
    assert.deepEqual(decideDraftReadyPromotion(base()), { action: "promote" });
  });

  it("stays draft when CI not green", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({ ciStatus: { status: "pending", checkedAt: "", source: "github" } }),
      ),
      { action: "none" },
    );
  });

  it("stays draft when approval before CI (pending)", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({ ciStatus: { status: "pending", checkedAt: "", source: "github" } }),
      ),
      { action: "none" },
    );
  });

  it("promotes only after CI green following approval", () => {
    const pending = decideDraftReadyPromotion(
      base({ ciStatus: { status: "pending", checkedAt: "", source: "github" } }),
    );
    assert.equal(pending.action, "none");
    const green = decideDraftReadyPromotion(base());
    assert.equal(green.action, "promote");
  });

  it("stays draft on CHANGES / non-approved stage", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(base({ stage: "changes_remaining", lastVerdict: "CHANGES" })),
      { action: "none" },
    );
    assert.deepEqual(decideDraftReadyPromotion(base({ stage: "failed", lastVerdict: null })), {
      action: "none",
    });
  });

  it("does not promote stale head after approve", () => {
    assert.deepEqual(decideDraftReadyPromotion(base({ currentHeadSha: "def" })), {
      action: "none",
    });
  });

  it("does not promote when remote PR head moved after approve (local unchanged)", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(base({ approveHeadSha: "abc", currentHeadSha: "newer-on-github" })),
      { action: "none" },
    );
  });

  it("idempotent when already ready", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(base({ isDraft: false, readyPromotedAt: "2026-01-01T00:00:00Z" })),
      { action: "already_ready" },
    );
  });

  it("duplicate poll with readyPromotedAt set stays none if still draft flag", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(base({ readyPromotedAt: "2026-01-01T00:00:00Z", isDraft: true })),
      { action: "none" },
    );
  });

  it("docs jobs promote on doc-checks success (not GHA CI)", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({
          docsJob: true,
          ciStatus: { status: "success", summary: "N/A", checkedAt: "", source: "doc-checks" },
        }),
      ),
      { action: "promote" },
    );
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({
          docsJob: true,
          ciStatus: { status: "failure", summary: "lint", checkedAt: "", source: "doc-checks" },
        }),
      ),
      { action: "none" },
    );
  });

  it("code jobs require CI success (neutral rollup does not promote)", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({ ciStatus: { status: "neutral", checkedAt: "", source: "github" } }),
      ),
      { action: "none" },
    );
  });

  it("docs jobs allow neutral doc-checks (soft lint)", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({
          docsJob: true,
          ciStatus: { status: "neutral", summary: "soft", checkedAt: "", source: "doc-checks" },
        }),
      ),
      { action: "promote" },
    );
  });

  it("docs jobs block ready on unknown doc-checks", () => {
    assert.deepEqual(
      decideDraftReadyPromotion(
        base({
          docsJob: true,
          ciStatus: { status: "unknown", checkedAt: "", source: "doc-checks" },
        }),
      ),
      { action: "none" },
    );
  });
});
