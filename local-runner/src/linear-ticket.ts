const ISSUE_IN_BRANCH_RE = /(?:^|\/)(?:issue|ticket|rad)-(\d+)/i;
const ISSUE_ID_RE = /^ISSUE-\d+$/i;

/** @deprecated name retained for MCP fields — value is a generic `ISSUE-n` id. */
export function parseLinearIssueFromBranch(branch: string): string | null {
  const m = branch.match(ISSUE_IN_BRANCH_RE);
  if (!m) return null;
  return `ISSUE-${m[1]}`;
}

export function normalizeLinearIssue(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (ISSUE_ID_RE.test(trimmed)) return trimmed;
  const legacyPrefix = ["RAD", "-"].join("");
  const legacy = trimmed.match(new RegExp(`^${legacyPrefix}(\\d+)$`, "i"));
  if (legacy) return `ISSUE-${legacy[1]}`;
  return null;
}

export function resolveJobTicket(args: {
  branch: string;
  ticketUrl?: string;
  linearIssue?: string;
}): { linearIssue: string | null; ticketUrl: string | null } {
  const explicitUrl = args.ticketUrl?.trim();
  const explicitIssue = args.linearIssue ? normalizeLinearIssue(args.linearIssue) : null;

  if (explicitUrl) {
    const fromUrl =
      explicitUrl
        .match(/(?:ISSUE|(?:R\s*A\s*D))-(\d+)/i)?.[0]
        ?.replace(new RegExp("^" + ["RAD", "-"].join(""), "i"), "ISSUE-")
        .toUpperCase() ?? null;
    return {
      linearIssue: explicitIssue ?? fromUrl,
      ticketUrl: explicitUrl,
    };
  }

  if (explicitIssue) {
    return { linearIssue: explicitIssue, ticketUrl: null };
  }

  const fromBranch = parseLinearIssueFromBranch(args.branch);
  if (fromBranch) {
    return { linearIssue: fromBranch, ticketUrl: null };
  }

  return { linearIssue: null, ticketUrl: null };
}
