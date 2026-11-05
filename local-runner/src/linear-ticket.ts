const RAD_IN_BRANCH_RE = /rad-(\d+)/i;
const LINEAR_ISSUE_RE = /^RAD-\d+$/i;

export function parseLinearIssueFromBranch(branch: string): string | null {
  const m = branch.match(RAD_IN_BRANCH_RE);
  if (!m) return null;
  return `RAD-${m[1]}`;
}

export function linearTicketUrl(issueId: string): string {
  const normalized = issueId.toUpperCase();
  return `https://linear.app/radiancelux/issue/${normalized}`;
}

export function normalizeLinearIssue(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  return LINEAR_ISSUE_RE.test(trimmed) ? trimmed : null;
}

export function resolveJobTicket(args: {
  branch: string;
  ticketUrl?: string;
  linearIssue?: string;
}): { linearIssue: string | null; ticketUrl: string | null } {
  const explicitUrl = args.ticketUrl?.trim();
  const explicitIssue = args.linearIssue ? normalizeLinearIssue(args.linearIssue) : null;

  if (explicitUrl) {
    const fromUrl = explicitUrl.match(/RAD-\d+/i)?.[0]?.toUpperCase() ?? null;
    return {
      linearIssue: explicitIssue ?? fromUrl,
      ticketUrl: explicitUrl,
    };
  }

  if (explicitIssue) {
    return { linearIssue: explicitIssue, ticketUrl: linearTicketUrl(explicitIssue) };
  }

  const fromBranch = parseLinearIssueFromBranch(args.branch);
  if (fromBranch) {
    return { linearIssue: fromBranch, ticketUrl: linearTicketUrl(fromBranch) };
  }

  return { linearIssue: null, ticketUrl: null };
}
