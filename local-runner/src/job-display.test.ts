import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ellipsizeAgentLabel,
  firstMarkdownHeading,
  humanizeKebabSlug,
  jobAgentDisplayLabel,
  linearSlugTitleFromTicketUrl,
  resolveJobTitle,
  stripRadIssuePrefix,
} from "./job-display.js";

describe("linearSlugTitleFromTicketUrl", () => {
  it("humanizes slug after issue id", () => {
    assert.equal(
      linearSlugTitleFromTicketUrl(
        "https://example.com/issue/ISSUE-327/local-runner-dashboard-blank",
      ),
      "local runner dashboard blank",
    );
  });

  it("returns null without slug segment", () => {
    assert.equal(linearSlugTitleFromTicketUrl("https://example.com/issue/ISSUE-320"), null);
  });
});

describe("firstMarkdownHeading", () => {
  it("reads first h1", () => {
    assert.equal(
      firstMarkdownHeading("intro\n# ISSUE-327: Fix parse\n## sub"),
      "ISSUE-327: Fix parse",
    );
  });
});

describe("stripRadIssuePrefix", () => {
  it("strips issue prefix variants", () => {
    assert.equal(stripRadIssuePrefix("ISSUE-327: Fix dashboard", "ISSUE-327"), "Fix dashboard");
    assert.equal(stripRadIssuePrefix("ISSUE-327 — Fix dashboard"), "Fix dashboard");
  });
});

describe("resolveJobTitle", () => {
  it("prefers explicit title", async () => {
    const t = await resolveJobTitle({
      title: "Custom",
      branch: "b",
      promptFile: "/nope",
    });
    assert.equal(t, "Custom");
  });

  it("uses ticket slug before prompt", async () => {
    const t = await resolveJobTitle({
      ticketUrl: "https://example.com/issue/ISSUE-1/my-slug",
      branch: "b",
      promptFile: "/nope",
    });
    assert.equal(t, "my slug");
  });

  it("uses prompt heading when no slug", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lr-title-"));
    const prompt = path.join(dir, "p.md");
    await writeFile(prompt, "# ISSUE-99: Ship feature\n", "utf8");
    const t = await resolveJobTitle({
      linearIssue: "ISSUE-99",
      branch: "feat/x",
      promptFile: prompt,
    });
    assert.equal(t, "Ship feature");
  });

  it("falls back to branch", async () => {
    const t = await resolveJobTitle({ branch: "feat/issue-327-fix", promptFile: "/nope" });
    assert.equal(t, "feat/issue-327-fix");
  });
});

describe("jobAgentDisplayLabel", () => {
  it("formats issue and title", () => {
    const r = jobAgentDisplayLabel({
      id: "abcd-efgh",
      title: "Fix parse",
      linearIssue: "ISSUE-327",
    });
    assert.equal(r.label, "ISSUE-327 · Fix parse");
    assert.equal(r.tooltip, r.label);
  });

  it("falls back to id prefix", () => {
    const r = jobAgentDisplayLabel({ id: "abcd-efgh-ijkl" });
    assert.equal(r.label, "abcd-efg");
  });
});

describe("ellipsizeAgentLabel", () => {
  it("truncates long labels", () => {
    assert.equal(ellipsizeAgentLabel("hello world", 8), "hello w…");
    assert.equal(humanizeKebabSlug("a-b"), "a b");
  });
});
