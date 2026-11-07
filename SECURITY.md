# Security policy

## Supported versions

Security fixes are applied on the default branch (`main`) and may be backported to the latest release tag at maintainers' discretion.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security-sensitive reports.**

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/radiancelux/prgenie/security/advisories/new):

1. Open the advisories page for this repository.
2. Choose **Report a vulnerability**.
3. Include steps to reproduce, impact, and suggested fixes if known.

Maintainers will acknowledge receipt, investigate, and coordinate disclosure. Allow reasonable time for a fix before public discussion.

## Scope

In scope: this repository's code, default configurations, and documented runner/plugin surfaces.

Out of scope: third-party services (GitHub, Cursor, Resend), misconfigured publicly exposed runner instances, or issues requiring physical access to a contributor machine.

## Secrets hygiene

- Never commit `.env`, API keys, runner bearer tokens, or `gh` credentials.
- Use `.env.example` as a template only; store real values locally or in your CI secret store.
- The local runner binds to localhost by default; treat `PRGENIE_RUNNER_TOKEN` like a password.
