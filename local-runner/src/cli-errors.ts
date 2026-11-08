export function cliErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function printCliError(err: unknown): void {
  const msg = cliErrorMessage(err);
  // eslint-disable-next-line no-console
  console.error(`prgenie: ${msg}`);
  const debug = process.env.PRGENIE_DEBUG === "1" || process.env.PRGENIE_DEBUG === "true";
  if (debug && err instanceof Error && err.stack) {
    // eslint-disable-next-line no-console
    console.error(err.stack);
  }
}

/** Top-level wrapper so CLI rejections exit cleanly without Node stack traces. */
export function runCli(main: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(main)
    .catch((err) => {
      printCliError(err);
      process.exit(1);
    });
}
