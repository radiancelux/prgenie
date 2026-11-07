import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROUND_STATE_BODY } from "./roundState.js";

type Saved = Record<string, boolean>;
type Round = { round: number };

const { pruneRoundCollapsed, roundCollapsedAfterToggle, isRoundExpandedIn } = new Function(
  `${ROUND_STATE_BODY}; return { pruneRoundCollapsed, roundCollapsedAfterToggle, isRoundExpandedIn };`,
)() as {
  pruneRoundCollapsed: (
    saved: Saved | undefined,
    rounds: Round[],
    previousLatest: string | undefined,
  ) => { collapsed: Saved; latest: string | undefined };
  roundCollapsedAfterToggle: (
    saved: Saved | undefined,
    round: number | string,
    collapsed: boolean,
    isLast: boolean,
  ) => Saved;
  isRoundExpandedIn: (saved: Saved | undefined, round: number | string, isLast: boolean) => boolean;
};

const rounds = (...ns: number[]): Round[] => ns.map((round) => ({ round }));

describe("review round collapse state", () => {
  it("defaults to the latest round open and older rounds collapsed", () => {
    assert.equal(isRoundExpandedIn(undefined, 1, false), false);
    assert.equal(isRoundExpandedIn(undefined, 2, true), true);
    assert.equal(isRoundExpandedIn({ "1": false }, 1, false), true);
    assert.equal(isRoundExpandedIn({ "2": true }, 2, true), false);
  });

  it("stores only explicit deviations from the default", () => {
    // The render-time toggle of the default-open latest round is not "explicit open".
    assert.deepEqual(roundCollapsedAfterToggle({}, 2, false, true), {});
    assert.deepEqual(roundCollapsedAfterToggle({}, 1, false, false), { "1": false });
    assert.deepEqual(roundCollapsedAfterToggle({ "1": false }, 1, true, false), {});
    assert.deepEqual(roundCollapsedAfterToggle({}, 2, true, true), { "2": true });
  });

  it("prunes saved state for rounds that no longer exist when the signature changes", () => {
    const next = pruneRoundCollapsed({ "1": false, "2": true, "7": false }, rounds(1, 2), "2");
    assert.deepEqual(next, { collapsed: { "1": false, "2": true }, latest: "2" });
  });

  it("keeps state unchanged when rounds are momentarily empty", () => {
    assert.deepEqual(pruneRoundCollapsed({ "1": false }, [], "1"), {
      collapsed: { "1": false },
      latest: "1",
    });
  });

  it("drops stale explicit-open state when a new round arrives", () => {
    // Round 1 was opened explicitly while round 2 was latest; round 2 was collapsed.
    const saved = roundCollapsedAfterToggle(
      roundCollapsedAfterToggle({}, 1, false, false),
      2,
      true,
      true,
    );
    const next = pruneRoundCollapsed(saved, rounds(1, 2, 3), "2");
    assert.deepEqual(next, { collapsed: {}, latest: "3" });
    assert.equal(isRoundExpandedIn(next.collapsed, 1, false), false);
    assert.equal(isRoundExpandedIn(next.collapsed, 2, false), false);
    assert.equal(isRoundExpandedIn(next.collapsed, 3, true), true);
  });

  it("keeps explicitly collapsed older rounds collapsed across a round change", () => {
    const next = pruneRoundCollapsed({ "1": true, "2": false }, rounds(1, 2, 3), "2");
    assert.equal(isRoundExpandedIn(next.collapsed, 1, false), false);
    assert.equal(isRoundExpandedIn(next.collapsed, 2, false), false);
  });

  it("resets a stale saved entry for the new latest round", () => {
    // e.g. round 3 was collapsed, then removed and recreated as the newest round.
    const next = pruneRoundCollapsed({ "3": true }, rounds(1, 2, 3), "2");
    assert.equal(isRoundExpandedIn(next.collapsed, 3, true), true);
  });

  it("does not reset explicit opens when only counts change within the same rounds", () => {
    const next = pruneRoundCollapsed({ "1": false }, rounds(1, 2), "2");
    assert.deepEqual(next.collapsed, { "1": false });
  });
});
