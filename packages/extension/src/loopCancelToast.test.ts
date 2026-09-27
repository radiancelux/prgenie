import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESUME_LOOP_ACTION,
  cancelLoop,
  cancelToastCopy,
  resumeToastCopy,
} from "./loopCancelToast.js";

test("RAD-139: cancel writes abort token before marker", async () => {
  const order: string[] = [];
  await cancelLoop({
    abort: async () => {
      order.push("abort");
    },
    writeMarker: async () => {
      order.push("marker");
    },
  });
  assert.deepEqual(order, ["abort", "marker"]);
});

test("RAD-139: cancel and resume toast copy", () => {
  const cancel = cancelToastCopy("My loop");
  assert.equal(
    cancel.message,
    "Loop My loop cancelled. Agents will not run CI or continue until you resume.",
  );
  assert.equal(cancel.actionTitle, RESUME_LOOP_ACTION);
  assert.equal(resumeToastCopy("My loop"), "Loop My loop resumed. The steward can continue.");
});
