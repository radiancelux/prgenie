# Runner dashboard evidence (synthetic)

Screenshots are generated with `timeout 120 pnpm exec tsx scripts/capture-dashboard-evidence.mjs` after `pnpm build`.

- Fixture uses synthetic issue/repo identifiers only.
- The first agent is expanded, so each screenshot shows its detail panel (transcript, steer, stop) inline beneath its own row or card.
- The third agent is `failed`, so its row/card shows **Remove**; the running agents show none. The toolbar shows **Show archived**, **Clear failed** (with **Include stuck & stopped**) and the archived count.
- Playwright headless Chromium: mobile cards at 360 / 390 px, desktop table at 768 / 1280 px.
- The script exits on its own; each screenshot and the whole run are capped by timeouts.
- Inline placement, single expansion, collapse, `aria-expanded` / `aria-controls`, re-render stability, and Remove / Clear failed / Restore / live list updates are covered by jsdom tests in `local-runner/src/ui-html.test.ts`.
