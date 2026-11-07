import { JOB_ERROR_MAX_LEN } from "./runner-policy.js";

/** Append a bounded, de-duplicated error string on the job record. */
export function setJobError(current: string | null, addition: string): string {
  const part = addition.trim();
  if (!part) return current?.trim() || "";
  const base = current?.trim() || "";
  if (!base) return part.slice(0, JOB_ERROR_MAX_LEN);
  if (base.includes(part)) return base.slice(0, JOB_ERROR_MAX_LEN);
  if (part.includes(base)) return part.slice(0, JOB_ERROR_MAX_LEN);
  const combined = `${base}; ${part}`;
  return combined.length <= JOB_ERROR_MAX_LEN
    ? combined
    : `${combined.slice(0, JOB_ERROR_MAX_LEN - 1)}…`;
}

export function mergeJobErrors(a: string | null, b: string | null): string | null {
  if (!a?.trim()) return b?.trim() || null;
  if (!b?.trim()) return a.trim();
  return setJobError(a, b) || null;
}
