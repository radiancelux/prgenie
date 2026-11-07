# Runner dashboard evidence (synthetic)

Screenshots are generated with `timeout 120 pnpm exec tsx scripts/capture-dashboard-evidence.mjs` after `pnpm build`.

- Fixture uses synthetic issue/repo identifiers only.
- The first agent is expanded, so each screenshot shows its detail panel (transcript, steer, stop) inline beneath its own row or card.
- The third agent is `failed`, so its row/card shows **Remove**; the running agents show none. The toolbar shows **Show archived**, **Clear failed** (with **Include stuck & stopped**) and the archived count.
- Playwright headless Chromium: cards at 360 / 390 / 768 px, table at 1024 / 1280 px. The 12-column table needs the `lg` breakpoint (1024px); below it the dashboard uses cards.
- `timeout 180 pnpm exec tsx scripts/check-dashboard-overflow.mjs` loads the live dashboard in Chromium with long unbroken log lines expanded and fails on any horizontal page overflow from 320 to 1440 px (also with the table forced on at 768 / 1024 px).
- The script exits on its own; each screenshot and the whole run are capped by timeouts.
- Inline placement, single expansion, collapse, `aria-expanded` / `aria-controls`, re-render stability, and Remove / Clear failed / Restore / live list updates are covered by jsdom tests in `local-runner/src/ui-html.test.ts`.
