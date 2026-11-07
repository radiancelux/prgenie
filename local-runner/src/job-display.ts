import { readFile } from "node:fs/promises";

/** Parse human title from a Linear issue URL slug segment (after issue id). */
export function linearSlugTitleFromTicketUrl(ticketUrl: string | null | undefined): string | null {
  const u = ticketUrl?.trim();
  if (!u) return null;
  const m = u.match(/\/issue\/[^/]+\/([^/?#]+)/i);
  if (!m?.[1]) return null;
  return humanizeKebabSlug(m[1]);
}

export function humanizeKebabSlug(slug: string): string {
  const t = slug.trim().replace(/-/g, " ").replace(/\s+/g, " ");
  return t || slug.trim();
}

const MARKDOWN_H1_RE = /^#\s+(.+?)\s*$/;

/** First `# heading` in markdown text. */
export function firstMarkdownHeading(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(MARKDOWN_H1_RE);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Drop a leading `ISSUE-n:` / `ISSUE-n —` prefix (and explicit issue id when provided). */
export function stripRadIssuePrefix(heading: string, linearIssue?: string | null): string {
  let t = heading.trim();
  t = t.replace(/^(?:ISSUE|RAD)-\d+\s*[:\u2014\u2013-]\s*/i, "");
  const issue = linearIssue?.trim();
  if (issue) {
    const esc = issue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^${esc}\\s*[:\u2014\u2013-]\\s*`, "i"), "");
  }
  const stripped = t.trim();
  return stripped || heading.trim();
}

export async function resolveJobTitle(args: {
  title?: string;
  ticketUrl?: string | null;
  linearIssue?: string | null;
  branch: string;
  promptFile: string;
}): Promise<string> {
  const explicit = args.title?.trim();
  if (explicit) return explicit;

  const fromLinear = linearSlugTitleFromTicketUrl(args.ticketUrl);
  if (fromLinear) return fromLinear;

  try {
    const raw = await readFile(args.promptFile, "utf8");
    const heading = firstMarkdownHeading(raw);
    if (heading) return stripRadIssuePrefix(heading, args.linearIssue);
  } catch {
    /* prompt may not exist yet at job create */
  }

  const branch = args.branch.trim();
  return branch || "agent";
}

export type JobAgentDisplayFields = {
  id: string;
  title?: string | null;
  linearIssue?: string | null;
  ticketUrl?: string | null;
  input?: { branch?: string } | null;
};

/** Primary agent row label: `{issueId} · {title}` when a Linear id is known. */
export function jobAgentDisplayLabel(job: JobAgentDisplayFields): {
  label: string;
  tooltip: string;
} {
  const base =
    job.title?.trim() ||
    linearSlugTitleFromTicketUrl(job.ticketUrl) ||
    job.input?.branch?.trim() ||
    job.id.slice(0, 8);
  const issue = job.linearIssue?.trim();
  const full = issue ? `${issue} · ${base}` : base;
  return { label: full, tooltip: full };
}

export type JobTicketLink = { url: string; label: string };

export type JobTicketFields = {
  title?: string | null;
  linearIssue?: string | null;
  ticketUrl?: string | null;
  ticketUrls?: string[] | null;
};

/** `#143` for GitHub issues/PRs, the issue id for Linear-style `/issue/ABC-12` URLs. */
export function ticketLinkLabel(url: string): string | null {
  const gh = url.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/i);
  if (gh) return "#" + gh[1];
  const issue = url.match(/\/issue\/([a-z]+-\d+)(?:[/?#]|$)/i);
  return issue ? issue[1].toUpperCase() : null;
}

/**
 * Every http(s) ticket a job covers, primary first. A GitHub job titled `#143 #144 …` also links
 * the leading `#n` issues in its primary ticket's repo.
 */
export function jobTicketLinks(job: JobTicketFields): JobTicketLink[] {
  const urls: string[] = [];
  const given: unknown[] = [job.ticketUrl].concat(
    Array.isArray(job.ticketUrls) ? job.ticketUrls : [],
  );
  for (const raw of given) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (/^https?:\/\/\S+$/i.test(url) && !urls.includes(url)) urls.push(url);
  }
  const repo = urls.length
    ? urls[0].match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/(?:issues|pull)\/\d+/i)
    : null;
  const leading = repo ? (job.title || "").match(/^(?:#\d+[\s,&+]*)+/) : null;
  for (const n of leading ? leading[0].match(/\d+/g) || [] : []) {
    if (!urls.some((url) => ticketLinkLabel(url) === "#" + n)) urls.push(repo![1] + "/issues/" + n);
  }
  return urls.map((url, i) => ({
    url,
    label:
      ticketLinkLabel(url) ||
      (i === 0 && job.linearIssue
        ? job.linearIssue
        : urls.length > 1
          ? "ticket " + (i + 1)
          : "ticket"),
  }));
}

/** Character cap helper for narrow layouts (~390px); CSS ellipsis is primary in the dashboard. */
export function ellipsizeAgentLabel(text: string, maxChars: number): string {
  if (maxChars < 2 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
