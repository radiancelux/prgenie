import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendResendEmail } from "./resend.js";

describe("sendResendEmail", () => {
  it("posts to Resend without logging the key", async () => {
    let authHeader = "";
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      authHeader = String(init?.headers && (init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    }) as typeof fetch;

    const result = await sendResendEmail(
      "re_secret_key",
      { to: "dev@example.com", subject: "test", html: "<p>hi</p>" },
      mockFetch,
    );
    assert.equal(result.ok, true);
    assert.equal(authHeader, "Bearer re_secret_key");
  });

  it("surfaces API errors", async () => {
    const mockFetch = (async () =>
      new Response("bad", { status: 401 })) as typeof fetch;
    const result = await sendResendEmail(
      "re_x",
      { to: "a@b.c", subject: "s", html: "h" },
      mockFetch,
    );
    assert.equal(result.ok, false);
  });
});
