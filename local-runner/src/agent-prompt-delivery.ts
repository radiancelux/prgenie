import path from "node:path";
import { writeFile } from "node:fs/promises";
import { buildCursorAgentSpawn } from "./cursor-agent-cli.js";

export type CursorAgentPromptDelivery =
  | { mode: "argv"; promptArgv: string }
  | { mode: "stdin"; prompt: string }
  | { mode: "prompt-file"; promptFile: string; prompt: string; instructionArgv: string };

export function cursorAgentMustNotPassPromptInArgv(
  platform: NodeJS.Platform,
  resolvedBinary: string,
  prompt: string,
): boolean {
  if (/[\r\n]/.test(prompt)) return true;
  if (platform !== "win32") return false;
  const ext = path.extname(resolvedBinary).toLowerCase();
  if (ext === ".ps1" || ext === ".cmd" || ext === ".bat") return true;
  return resolvedBinary === "cursor-agent" || resolvedBinary === "agent";
}

export function planCursorAgentPromptDelivery(
  prompt: string,
  platform: NodeJS.Platform,
  resolvedBinary: string,
): CursorAgentPromptDelivery {
  if (!cursorAgentMustNotPassPromptInArgv(platform, resolvedBinary, prompt)) {
    return { mode: "argv", promptArgv: prompt };
  }
  return { mode: "stdin", prompt };
}

export function cursorAgentBaseArgs(model: string, outputFormat: "stream-json" | "text"): string[] {
  return ["-p", "--force", "--trust", "--model", model, "--output-format", outputFormat];
}

export type PlannedCursorAgentSpawn = {
  command: string;
  args: string[];
  stdin?: string;
  delivery: CursorAgentPromptDelivery;
};

export function planCursorAgentSpawn(
  resolvedBinary: string,
  model: string,
  outputFormat: "stream-json" | "text",
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): PlannedCursorAgentSpawn {
  const base = cursorAgentBaseArgs(model, outputFormat);
  const delivery = planCursorAgentPromptDelivery(prompt, platform, resolvedBinary);
  let args: string[];
  let stdin: string | undefined;
  if (delivery.mode === "argv") {
    args = [...base, delivery.promptArgv];
  } else if (delivery.mode === "stdin") {
    args = base;
    stdin = delivery.prompt;
  } else {
    args = [...base, delivery.instructionArgv];
    stdin = undefined;
  }
  const spawn = buildCursorAgentSpawn(resolvedBinary, args, platform);
  return { ...spawn, stdin, delivery };
}

/** Write prompt to a job-scoped file when stdin is not viable (tests / fallback). */
export async function writeCursorAgentPromptFile(
  artifactsDir: string,
  stage: string,
  prompt: string,
): Promise<string> {
  const file = path.join(artifactsDir, `agent-prompt-${stage}.md`);
  await writeFile(file, prompt, "utf8");
  return file;
}
