# Runner dashboard evidence (synthetic)

Screenshots are generated with `pnpm exec tsx scripts/capture-dashboard-evidence.mjs` after `pnpm build`.

- Fixture uses synthetic issue/repo identifiers only.
- Playwright headless Chromium at 360 / 390 / 768 px viewport widths.
- Desktop layout is covered by jsdom render tests; physical device verification is still operator-optional.
