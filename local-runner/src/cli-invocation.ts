/** True when this process was launched via npx (typical `npx -y prgenie …`). */
export function runningViaNpx(env: NodeJS.ProcessEnv = process.env): boolean {
  const ua = env.npm_config_user_agent ?? "";
  if (/npx/i.test(ua)) return true;
  const execpath = env.npm_execpath ?? "";
  if (/npx/i.test(execpath)) return true;
  // npm 7+ runs npx as `npm exec`; the user agent and execpath no longer mention npx.
  const command = env.npm_command ?? "";
  if (command === "exec" || command === "npx") return true;
  return env.npm_lifecycle_event === "npx";
}

/** User-facing command prefix for next-step hints (`prgenie` vs `npx -y prgenie@latest`). */
export function prgenieCmd(subcommand: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = subcommand.trim();
  if (runningViaNpx(env)) {
    return `npx -y prgenie@latest ${trimmed}`;
  }
  return `prgenie ${trimmed}`;
}
