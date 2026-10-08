import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { eventName, inferCwd } from "./review-hook.js";

test("inferCwd prefers cwd then workspace_roots then process.cwd", () => {
  assert.equal(inferCwd({ cwd: "C:/repo" }), path.normalize("C:/repo"));
  assert.equal(inferCwd({ workspace_roots: ["C:/ws"] }), path.normalize("C:/ws"));
  assert.equal(inferCwd({ cwd: "", workspace_roots: ["C:/ws"] }), path.normalize("C:/ws"));
  assert.equal(inferCwd({}), process.cwd());
});

test("eventName reads hook_event_name or event", () => {
  assert.equal(eventName({ hook_event_name: "stop" }), "stop");
  assert.equal(eventName({ event: "sessionStart" }), "sessionStart");
  assert.equal(eventName({}), "");
});
