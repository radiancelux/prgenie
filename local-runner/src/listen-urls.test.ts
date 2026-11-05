import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runnerListenUrls, urlHostForRequest } from "./listen-urls.js";

describe("runner listen URLs", () => {
  it("defaults to localhost URL", () => {
    assert.deepEqual(runnerListenUrls("127.0.0.1", 9473), ["http://127.0.0.1:9473/"]);
  });

  it("includes loopback and LAN hint when bound to all interfaces", () => {
    const urls = runnerListenUrls("0.0.0.0", 9473);
    assert.equal(urls[0], "http://127.0.0.1:9473/");
    assert.ok(urls.length >= 1);
  });

  it("maps 0.0.0.0 to loopback for request URL parsing", () => {
    assert.equal(urlHostForRequest("0.0.0.0"), "127.0.0.1");
  });
});
