import {
  findLocalPrForCurrentWorktree,
  isArchivedPr,
  listLocalPrs,
} from "./prs.js";
import type { LocalPr } from "./types.js";
import type { WatchRole } from "./watch.js";

function commentSig(pr: LocalPr): string {
  return (pr.comments ?? [])
    .map((c) => `${c.id}:${c.status ?? ""}:${c.body.length}:${c.replyTo ?? ""}`)
    .join(",");
}

function liveSig(pr: LocalPr): string {
  return `${pr.id}:${pr.status}:${pr.headSha}:${pr.updatedAt}:${commentSig(pr)}`;
}

/** Fingerprint of flywheel state that should reset listen idle for this role. */
export async function listenActivityFingerprint(
  cwd: string,
  role: WatchRole,
): Promise<string> {
  const all = await listLocalPrs(cwd);
  const live = all.filter((p) => !isArchivedPr(p));
  if (role === "inbox") {
    const here = await findLocalPrForCurrentWorktree(cwd);
    if (!here || isArchivedPr(here)) {
      return `inbox:none:${live.map((p) => p.id).sort().join(",")}`;
    }
    return `inbox:${liveSig(here)}`;
  }
  const ready = live
    .filter((p) => p.status === "ready")
    .map((p) => `${p.id}:${p.headSha}:${p.updatedAt}:${p.reviewerNotifiedSha ?? ""}`)
    .sort();
  const others = live
    .filter((p) => p.status !== "ready")
    .map((p) => `${p.id}:${p.status}:${p.headSha}:${p.updatedAt}`)
    .sort();
  return `queue:ready=${ready.join("|")};live=${others.join("|")}`;
}
