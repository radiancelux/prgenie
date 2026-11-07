/** Populated by esbuild `define` when `pnpm build` compiles the runner. */
declare const __DASHBOARD_CSS__: string | undefined;

/** Minimal fallback so typecheck and unit tests work without a Tailwind build step. */
const FALLBACK_CSS = `*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec}:focus-visible{outline:2px solid #7eb8ff;outline-offset:2px}`;

export function dashboardStylesheet(): string {
  const css =
    typeof __DASHBOARD_CSS__ !== "undefined" && __DASHBOARD_CSS__
      ? __DASHBOARD_CSS__
      : FALLBACK_CSS;
  return `<style>${css}</style>`;
}
