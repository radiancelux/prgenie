export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
}

export interface RepoGithubBind {
  host: string;
  login: string;
}

export function parseGhAuthStatus(text: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let pending: { host: string; login: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const loginMatch = line.match(/Logged in to (\S+) account (\S+)/i);
    if (loginMatch) {
      pending = { host: loginMatch[1], login: loginMatch[2] };
      continue;
    }
    const activeMatch = line.match(/Active account:\s*(true|false)/i);
    if (activeMatch && pending) {
      accounts.push({
        host: pending.host,
        login: pending.login,
        active: activeMatch[1].toLowerCase() === "true",
      });
      pending = null;
    }
  }
  if (pending) {
    accounts.push({ ...pending, active: false });
  }
  return accounts;
}
