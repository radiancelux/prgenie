import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGitHubRemoteUrl,
  jobRepoDisplayLabel,
  repoBasenameFromPath,
  repoOwnerNameFromRemoteUrl,
} from "./repo-display.js";

describe("isGitHubRemoteUrl", () => {
  it("accepts https, scp-style ssh, and ssh:// github.com remotes", () => {
    assert.equal(isGitHubRemoteUrl("https://github.com/radiancelux/prgenie.git"), true);
    assert.equal(isGitHubRemoteUrl("git@github.com:acme/widget.git"), true);
    assert.equal(isGitHubRemoteUrl("ssh://git@github.com/acme/widget"), true);
  });

  it("rejects other hosts and lookalikes", () => {
    assert.equal(isGitHubRemoteUrl("git@gitlab.com:acme/widget.git"), false);
    assert.equal(isGitHubRemoteUrl("https://notgithub.com/acme/widget"), false);
    assert.equal(isGitHubRemoteUrl("https://github.com.evil.io/acme/widget"), false);
    assert.equal(isGitHubRemoteUrl(""), false);
  });
});

describe("repoOwnerNameFromRemoteUrl", () => {
  it("parses https github remotes", () => {
    assert.equal(
      repoOwnerNameFromRemoteUrl("https://github.com/radiancelux/prgenie.git"),
      "radiancelux/prgenie",
    );
  });

  it("parses ssh github remotes", () => {
    assert.equal(repoOwnerNameFromRemoteUrl("git@github.com:acme/widget.git"), "acme/widget");
  });

  it("returns null for empty input", () => {
    assert.equal(repoOwnerNameFromRemoteUrl(""), null);
  });
});

describe("repoBasenameFromPath", () => {
  it("uses the final path segment", () => {
    assert.equal(repoBasenameFromPath("/home/me/work/prgenie"), "prgenie");
    assert.equal(repoBasenameFromPath("C:\\repos\\my-app\\"), "my-app");
  });
});

describe("jobRepoDisplayLabel", () => {
  it("prefers owner/name slug, then remote, then basename", () => {
    assert.equal(jobRepoDisplayLabel({ repoSlug: "o/r" }), "o/r");
    assert.equal(
      jobRepoDisplayLabel({
        repoSlug: "prgenie",
        input: { remote: "git@github.com:acme/widget.git" },
      }),
      "acme/widget",
    );
    assert.equal(
      jobRepoDisplayLabel({ repoSlug: "prgenie", input: { repoPath: "/tmp/radiancelux/prgenie" } }),
      "prgenie",
    );
  });
});
