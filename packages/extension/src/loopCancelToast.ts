export const RESUME_LOOP_ACTION = "Resume loop";

export function cancelToastCopy(title: string): { message: string; actionTitle: string } {
  return {
    message: `Loop ${title} cancelled. Agents will not run CI or continue until you resume.`,
    actionTitle: RESUME_LOOP_ACTION,
  };
}

export function resumeToastCopy(title: string): string {
  return `Loop ${title} resumed. The steward can continue.`;
}

/** Panel Cancel: abort token first, then persistent cancel marker (RAD-139). */
export async function cancelLoop(deps: {
  abort: () => Promise<unknown>;
  writeMarker: () => Promise<void>;
}): Promise<void> {
  await deps.abort();
  await deps.writeMarker();
}
