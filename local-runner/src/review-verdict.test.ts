import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerdictFromText } from "./github.js";
import {
  localVerdictCommentBody,
  parseLocalReviewVerdict,
  resolveReviewVerdict,
  reviewerFinalText,
} from "./review-verdict.js";

function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function assistant(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

const cursorAgentApprove = jsonl(
  { type: "system", subtype: "init", model: "composer-2.5" },
  assistant("Reading the diff."),
  {
    type: "tool_call",
    subtype: "completed",
    tool_call: { shellToolCall: { args: { command: "git diff" }, result: { success: {} } } },
  },
  assistant("Retopo helpers look correct.\n\nVERDICT: APPROVE"),
  {
    type: "result",
    subtype: "success",
    result: "Reading the diff.Retopo helpers look correct.\n\nVERDICT: APPROVE",
  },
);

describe("reviewerFinalText", () => {
  it("prefers the stream-json result event", () => {
    assert.equal(
      reviewerFinalText(cursorAgentApprove, "stream-json"),
      "Reading the diff.Retopo helpers look correct.\n\nVERDICT: APPROVE",
    );
  });

  it("falls back to the last assistant message when no result event arrived", () => {
    const out = jsonl(assistant("First pass."), assistant("Needs tests.\nVERDICT: CHANGES"));
    assert.equal(reviewerFinalText(out, "stream-json"), "Needs tests.\nVERDICT: CHANGES");
  });

  it("ignores stderr noise and partial lines in stream-json output", () => {
    const out = `warning: something\n${jsonl(assistant("Fine.\nVERDICT: APPROVE"))}{"type":"assi`;
    assert.equal(reviewerFinalText(out, "stream-json"), "Fine.\nVERDICT: APPROVE");
  });

  it("uses text output as-is", () => {
    assert.equal(reviewerFinalText("  ok\nVERDICT: APPROVE\n", "text"), "ok\nVERDICT: APPROVE");
  });
});

describe("parseLocalReviewVerdict", () => {
  it("reads APPROVE from a cursor-agent stream-json review", () => {
    assert.equal(parseLocalReviewVerdict(cursorAgentApprove, "stream-json"), "APPROVE");
  });

  it("reads CHANGES from local-model text output", () => {
    assert.equal(parseLocalReviewVerdict("Missing tests.\nVERDICT: CHANGES\n", "text"), "CHANGES");
  });

  it("ignores verdict lines that only appear in tool output", () => {
    const out = jsonl(
      {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: { command: "gh pr view 1 --comments" },
            result: { success: { stdout: "Old round\nVERDICT: APPROVE\n" } },
          },
        },
      },
      assistant("Still reviewing; no conclusion."),
    );
    assert.equal(parseLocalReviewVerdict(out, "stream-json"), null);
  });

  it("returns null when the reviewer gave no verdict", () => {
    assert.equal(parseLocalReviewVerdict(jsonl(assistant("Done.")), "stream-json"), null);
    assert.equal(parseLocalReviewVerdict("", "stream-json"), null);
  });
});

describe("resolveReviewVerdict", () => {
  it("uses the GitHub verdict and does not mirror when one was posted", async () => {
    const mirrored: string[] = [];
    const res = await resolveReviewVerdict({
      githubVerdict: "CHANGES",
      reviewOutput: cursorAgentApprove,
      outputFormat: "stream-json",
      mirrorToPr: async (body) => {
        mirrored.push(body);
        return true;
      },
    });
    assert.deepEqual(res, { verdict: "CHANGES", source: "github" });
    assert.equal(mirrored.length, 0);
  });

  it("accepts the reviewer's local verdict when nothing was posted (custom prompt case)", async () => {
    const mirrored: string[] = [];
    const logs: string[] = [];
    const res = await resolveReviewVerdict({
      githubVerdict: null,
      reviewOutput: cursorAgentApprove,
      outputFormat: "stream-json",
      mirrorToPr: async (body) => {
        mirrored.push(body);
        return true;
      },
      log: (line) => {
        logs.push(line);
      },
    });
    assert.deepEqual(res, { verdict: "APPROVE", source: "local" });
    assert.equal(mirrored.length, 1);
    assert.match(mirrored[0], /did not post it to the PR/);
    assert.match(mirrored[0], /Retopo helpers look correct/);
    assert.equal(parseVerdictFromText(mirrored[0]), "APPROVE");
    assert.ok(logs.some((l) => /local VERDICT: APPROVE/.test(l)));
    assert.ok(logs.some((l) => /Posted the reviewer's local verdict/.test(l)));
  });

  it("mirrors a local CHANGES review so the fixer can read the feedback on the PR", async () => {
    const mirrored: string[] = [];
    const res = await resolveReviewVerdict({
      githubVerdict: null,
      reviewOutput: "Add a regression test for empty meshes.\nVERDICT: CHANGES\n",
      outputFormat: "text",
      mirrorToPr: async (body) => {
        mirrored.push(body);
        return true;
      },
    });
    assert.deepEqual(res, { verdict: "CHANGES", source: "local" });
    assert.match(mirrored[0], /regression test for empty meshes/);
    assert.equal(parseVerdictFromText(mirrored[0]), "CHANGES");
  });

  it("keeps the local verdict when mirroring to the PR fails or throws", async () => {
    for (const mirrorToPr of [
      async () => false,
      async () => Promise.reject(new Error("gh down")),
    ]) {
      const logs: string[] = [];
      const res = await resolveReviewVerdict({
        githubVerdict: null,
        reviewOutput: cursorAgentApprove,
        outputFormat: "stream-json",
        mirrorToPr,
        log: (line) => {
          logs.push(line);
        },
      });
      assert.deepEqual(res, { verdict: "APPROVE", source: "local" });
      assert.ok(logs.some((l) => /Could not post/.test(l)));
    }
  });

  it("returns null without mirroring when neither GitHub nor the reviewer has a verdict", async () => {
    let mirrored = 0;
    const res = await resolveReviewVerdict({
      githubVerdict: null,
      reviewOutput: jsonl(assistant("Looked around.")),
      outputFormat: "stream-json",
      mirrorToPr: async () => {
        mirrored += 1;
        return true;
      },
    });
    assert.equal(res, null);
    assert.equal(mirrored, 0);
  });
});

describe("localVerdictCommentBody", () => {
  it("keeps the verdict tail when the review is longer than a GitHub comment allows", () => {
    const body = localVerdictCommentBody(`${"x".repeat(70_000)}\nVERDICT: CHANGES`);
    assert.ok(body.length < 65_536);
    assert.equal(parseVerdictFromText(body), "CHANGES");
  });
});
