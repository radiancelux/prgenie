export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
}

export interface RepoGithubBind {
  host: string;
  login: string;
}

/** Classic/OAuth token scopes listed under the active gh account (empty when not present). */
export function parseActiveGhTokenScopes(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let inActive = false;
  for (const line of lines) {
    if (/Logged in to \S+ account \S+/i.test(line)) {
      inActive = false;
    }
    if (/Active account:\s*true/i.test(line)) {
      inActive = true;
      continue;
    }
    if (/Active account:\s*false/i.test(line)) {
      inActive = false;
      continue;
    }
    if (!inActive) continue;
    const scopeMatch = line.match(/Token scopes:\s*(.+)$/i);
    if (!scopeMatch) continue;
    const raw = scopeMatch[1].trim();
    const scopes: string[] = [];
    const quoted = raw.match(/'([^']+)'/g);
    if (quoted) {
      for (const q of quoted) scopes.push(q.slice(1, -1));
      return scopes;
    }
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** True when the active token has classic scopes broader than loop agents need (RAD-163 R3). */
export function ghTokenScopesTooBroadForLoops(scopes: string[]): boolean {
  return scopes.some((scope) => {
    if (scope === "repo" || scope === "delete_repo" || scope === "workflow") return true;
    if (scope.startsWith("admin:")) return true;
    return false;
  });
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
