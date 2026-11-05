import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linearTicketUrl, parseLinearIssueFromBranch, resolveJobTicket } from "./linear-ticket.js";

describe("parseLinearIssueFromBranch", () => {
  it("parses RAD-n from branch names case-insensitively", () => {
    assert.equal(parseLinearIssueFromBranch("feat/rad-320-verdict-resend"), "RAD-320");
    assert.equal(parseLinearIssueFromBranch("RAD-321-ticket-ui"), "RAD-321");
    assert.equal(parseLinearIssueFromBranch("feat/no-ticket"), null);
  });
});

describe("resolveJobTicket", () => {
  it("falls back to branch when ticket args omitted", () => {
    const t = resolveJobTicket({ branch: "feat/rad-320-verdict-resend" });
    assert.equal(t.linearIssue, "RAD-320");
    assert.equal(t.ticketUrl, linearTicketUrl("RAD-320"));
  });

  it("prefers explicit ticketUrl and linearIssue", () => {
    const t = resolveJobTicket({
      branch: "feat/x",
      linearIssue: "rad-321",
      ticketUrl: "https://linear.app/radiancelux/issue/RAD-321/foo",
    });
    assert.equal(t.linearIssue, "RAD-321");
    assert.equal(t.ticketUrl, "https://linear.app/radiancelux/issue/RAD-321/foo");
  });
});
