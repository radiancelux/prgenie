import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveResendFromEmail, sendResendEmail } from "./resend.js";

describe("resolveResendFromEmail", () => {
  const prev = process.env.PRGENIE_RUNNER_FROM_EMAIL;

  afterEach(() => {
    if (prev === undefined) delete process.env.PRGENIE_RUNNER_FROM_EMAIL;
    else process.env.PRGENIE_RUNNER_FROM_EMAIL = prev;
  });

  it("defaults to example.com runner address", () => {
    delete process.env.PRGENIE_RUNNER_FROM_EMAIL;
    assert.equal(resolveResendFromEmail(), "PR Genie Local Runner <runner@example.com>");
  });

  it("accepts bare email override", () => {
    process.env.PRGENIE_RUNNER_FROM_EMAIL = "notify@example.com";
    assert.equal(resolveResendFromEmail(), "PR Genie Local Runner <notify@example.com>");
  });

  it("accepts full Name <addr> override", () => {
    process.env.PRGENIE_RUNNER_FROM_EMAIL = "Alerts <alerts@example.com>";
    assert.equal(resolveResendFromEmail(), "Alerts <alerts@example.com>");
  });
});

describe("sendResendEmail", () => {
  const prevFrom = process.env.PRGENIE_RUNNER_FROM_EMAIL;

  beforeEach(() => {
    delete process.env.PRGENIE_RUNNER_FROM_EMAIL;
  });

  afterEach(() => {
    if (prevFrom === undefined) delete process.env.PRGENIE_RUNNER_FROM_EMAIL;
    else process.env.PRGENIE_RUNNER_FROM_EMAIL = prevFrom;
  });

  it("posts to Resend without logging the key", async () => {
    let authHeader = "";
    let bodyJson: Record<string, unknown> = {};
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      authHeader = String(init?.headers && (init.headers as Record<string, string>).Authorization);
      bodyJson = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    }) as typeof fetch;

    const result = await sendResendEmail(
      "re_secret_key",
      { to: "dev@example.com", subject: "test", html: "<p>hi</p>" },
      mockFetch,
    );
    assert.equal(result.ok, true);
    assert.equal(authHeader, "Bearer re_secret_key");
    assert.equal(bodyJson.from, "PR Genie Local Runner <runner@example.com>");
  });

  it("surfaces API errors", async () => {
    const mockFetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
    const result = await sendResendEmail(
      "re_x",
      { to: "a@b.c", subject: "s", html: "h" },
      mockFetch,
    );
    assert.equal(result.ok, false);
  });
});
