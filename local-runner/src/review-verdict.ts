import { assistantText } from "./stream-json-log.js";
import { parseVerdictFromText, type Verdict } from "./github.js";

export type VerdictSource = "github" | "local";

/** GitHub rejects issue comments over 65,536 characters. */
const MAX_MIRROR_BODY_CHARS = 60_000;

/**
 * The reviewer's final message from raw agent stdout. Stream-json uses the `result` event
 * (or the last assistant message when no result event arrived); text output is used as-is.
 */
export function reviewerFinalText(output: string, format: "stream-json" | "text"): string {
  if (format === "text") return output.trim();
  let resultText: string | null = null;
  let lastAssistant = "";
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "result" && typeof ev.result === "string") {
      resultText = ev.result;
    } else if (ev.type === "assistant") {
      const text = assistantText(ev.message);
      if (text.trim()) lastAssistant = text;
    }
  }
  return (resultText ?? lastAssistant).trim();
}

export function parseLocalReviewVerdict(
  output: string,
  format: "stream-json" | "text",
): Verdict | null {
  return parseVerdictFromText(reviewerFinalText(output, format));
}

export function localVerdictCommentBody(finalText: string): string {
  const note =
    "_PR Genie runner: the reviewer returned this verdict locally but did not post it to the PR, so the runner posted it._";
  const text =
    finalText.length > MAX_MIRROR_BODY_CHARS
      ? `…\n${finalText.slice(finalText.length - MAX_MIRROR_BODY_CHARS)}`
      : finalText;
  return `${note}\n\n${text}`;
}

export type ResolvedReviewVerdict = { verdict: Verdict; source: VerdictSource };

/**
 * A verdict posted on GitHub wins. Otherwise accept the `VERDICT:` line from the reviewer's
 * final local message (custom review prompts may not ask for a PR comment) and mirror that
 * message to the PR so the fixer and humans can read the review.
 */
export async function resolveReviewVerdict(opts: {
  githubVerdict: Verdict | null;
  reviewOutput: string;
  outputFormat: "stream-json" | "text";
  mirrorToPr?: (body: string) => Promise<boolean>;
  log?: (line: string) => Promise<void> | void;
}): Promise<ResolvedReviewVerdict | null> {
  if (opts.githubVerdict) return { verdict: opts.githubVerdict, source: "github" };
  const finalText = reviewerFinalText(opts.reviewOutput, opts.outputFormat);
  const verdict = parseVerdictFromText(finalText);
  if (!verdict) return null;
  await opts.log?.(
    `[runner] No VERDICT on the PR this round; using the reviewer's local VERDICT: ${verdict}.`,
  );
  if (opts.mirrorToPr) {
    const posted = await opts.mirrorToPr(localVerdictCommentBody(finalText)).catch(() => false);
    await opts.log?.(
      posted
        ? "[runner] Posted the reviewer's local verdict to the PR as a comment."
        : "[runner] Could not post the reviewer's local verdict to the PR; continuing.",
    );
  }
  return { verdict, source: "local" };
}
