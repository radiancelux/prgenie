import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLinearIssueFromBranch, resolveJobTicket } from "./linear-ticket.js";

describe("parseLinearIssueFromBranch", () => {
  it("parses issue-n from branch names case-insensitively", () => {
    assert.equal(parseLinearIssueFromBranch("feat/issue-320-verdict-resend"), "ISSUE-320");
    assert.equal(parseLinearIssueFromBranch("feat/issue-321-ticket-ui"), "ISSUE-321");
    assert.equal(parseLinearIssueFromBranch("feat/no-ticket"), null);
  });
});

describe("resolveJobTicket", () => {
  it("falls back to branch when ticket args omitted", () => {
    const t = resolveJobTicket({ branch: "feat/issue-320-verdict-resend" });
    assert.equal(t.linearIssue, "ISSUE-320");
    assert.equal(t.ticketUrl, null);
  });

  it("prefers explicit ticketUrl and linearIssue", () => {
    const t = resolveJobTicket({
      branch: "feat/x",
      linearIssue: "issue-321",
      ticketUrl: "https://github.com/org/repo/issues/321",
    });
    assert.equal(t.linearIssue, "ISSUE-321");
    assert.equal(t.ticketUrl, "https://github.com/org/repo/issues/321");
  });
});
