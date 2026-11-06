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
        "https://linear.app/radiancelux/issue/RAD-327/local-runner-dashboard-blank",
      ),
      "local runner dashboard blank",
    );
  });

  it("returns null without slug segment", () => {
    assert.equal(
      linearSlugTitleFromTicketUrl("https://linear.app/radiancelux/issue/RAD-320"),
      null,
    );
  });
});

describe("firstMarkdownHeading", () => {
  it("reads first h1", () => {
    assert.equal(firstMarkdownHeading("intro\n# RAD-327: Fix parse\n## sub"), "RAD-327: Fix parse");
  });
});

describe("stripRadIssuePrefix", () => {
  it("strips RAD prefix variants", () => {
    assert.equal(stripRadIssuePrefix("RAD-327: Fix dashboard", "RAD-327"), "Fix dashboard");
    assert.equal(stripRadIssuePrefix("RAD-327 — Fix dashboard"), "Fix dashboard");
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

  it("uses linear slug before prompt", async () => {
    const t = await resolveJobTitle({
      ticketUrl: "https://linear.app/radiancelux/issue/RAD-1/my-slug",
      branch: "b",
      promptFile: "/nope",
    });
    assert.equal(t, "my slug");
  });

  it("uses prompt heading when no slug", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lr-title-"));
    const prompt = path.join(dir, "p.md");
    await writeFile(prompt, "# RAD-99: Ship feature\n", "utf8");
    const t = await resolveJobTitle({
      linearIssue: "RAD-99",
      branch: "feat/x",
      promptFile: prompt,
    });
    assert.equal(t, "Ship feature");
  });

  it("falls back to branch", async () => {
    const t = await resolveJobTitle({ branch: "feat/rad-327-fix", promptFile: "/nope" });
    assert.equal(t, "feat/rad-327-fix");
  });
});

describe("jobAgentDisplayLabel", () => {
  it("formats issue and title", () => {
    const r = jobAgentDisplayLabel({
      id: "abcd-efgh",
      title: "Fix parse",
      linearIssue: "RAD-327",
    });
    assert.equal(r.label, "RAD-327 · Fix parse");
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
