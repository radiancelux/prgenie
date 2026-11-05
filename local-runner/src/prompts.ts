export const DEFAULT_REVIEW_PROMPT = `You are the reviewer for one GitHub pull request.

Read the PR diff and existing comments. Post exactly ONE new PR review comment (not a review approval event) that summarizes findings.

Your comment MUST end with a single line in this exact format (no extra text after it):
VERDICT: APPROVE
or
VERDICT: CHANGES

Do not merge, push, or implement fixes. Do not post multiple verdict lines.`;

export const DEFAULT_FIX_PROMPT = `You are the fixer for an open pull request after review requested changes.

Rebase your branch on the default base branch, address all review feedback, commit, and push to update the PR.

Do not merge. Do not open a second PR. Do not force-push to main/master.`;
