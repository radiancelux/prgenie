# Repo review guidance (example — copy to `.prgenie/review.md`)

Stack- and org-specific rules for `/review` and steward-spawned reviewer Tasks. Apply **with** the plugin process bar (`packages/plugin/skills/review/process-bar.md`).

## Always apply

- No secrets, tokens, or PII in logs, comments, or error messages.
- Auth and permission checks on every new route or mutation path.
- Database migrations must be reversible or explicitly documented when not.
- Prefer existing UI primitives from the design system; no ad-hoc CSS when a component exists.
- React: hooks at top level only; no conditional hooks.
- API changes: update OpenAPI/types and add or adjust tests.

## Stack

Short opt-in category labels (ingested into `stackCategories` — not rule prose):

- React / frontend patterns
- API contract drift
- Missing tests on non-trivial logic

## Zero-tolerance

- secrets in logs or client bundles
- SQL injection or unsanitized HTML injection
- bypassing auth on write paths
