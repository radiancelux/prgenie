export interface ResendSendInput {
  to: string;
  subject: string;
  html: string;
}

export type FetchFn = typeof fetch;

const DEFAULT_FROM = "PR Genie Local Runner <runner@radiancelux.tech>";

/** Resend `from` address; override with PRGENIE_RUNNER_FROM_EMAIL (full `Name <addr>` or bare addr). */
export function resolveResendFromEmail(): string {
  const raw = process.env.PRGENIE_RUNNER_FROM_EMAIL?.trim();
  if (!raw) return DEFAULT_FROM;
  if (raw.includes("<") && raw.includes(">")) return raw;
  return `PR Genie Local Runner <${raw}>`;
}

export async function sendResendEmail(
  apiKey: string,
  input: ResendSendInput,
  fetchImpl: FetchFn = fetch,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resolveResendFromEmail(),
      to: [input.to],
      subject: input.subject,
      html: input.html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: body.slice(0, 500) || res.statusText };
  }
  const json = (await res.json()) as { id?: string };
  return { ok: true, id: json.id ?? "unknown" };
}

export function formatJobEmailHtml(opts: {
  headline: string;
  prUrl: string | null;
  verdict: string | null;
  stage: string;
  jobId: string;
}): string {
  const pr = opts.prUrl
    ? `<p><a href="${opts.prUrl}">${opts.prUrl}</a></p>`
    : "<p>(no PR link)</p>";
  const verdict = opts.verdict ? `<p>Verdict: <strong>${opts.verdict}</strong></p>` : "";
  return `<h2>${opts.headline}</h2><p>Job ${opts.jobId} — stage ${opts.stage}</p>${pr}${verdict}`;
}
