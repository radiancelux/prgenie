import { appendFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  logPath: string;
  dryRun?: boolean;
  /** stream-json for live UI; text is end-only (Batch G). */
  outputFormat?: "stream-json" | "text";
  signal?: AbortSignal;
}

export interface AgentRunResult {
  code: number;
  output: string;
}

export class AgentRunner extends EventEmitter {
  private child: ChildProcess | null = null;

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const outputFormat = opts.outputFormat ?? "stream-json";
    await appendFile(opts.logPath, `\n--- agent (${opts.model}, ${outputFormat}) ---\n`, "utf8");

    if (opts.dryRun) {
      const fake =
        `[dry-run] cursor-agent would run in ${opts.cwd}\n` +
        `${opts.prompt.slice(0, 200)}...\n`;
      await appendFile(opts.logPath, fake, "utf8");
      this.emit("line", fake);
      return { code: 0, output: fake };
    }

    const args = [
      "-p",
      "--force",
      "--trust",
      "--model",
      opts.model,
      "--output-format",
      outputFormat,
      opts.prompt,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn("cursor-agent", args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      let output = "";

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const handleChunk = async (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        if (outputFormat === "stream-json") {
          for (const line of text.split(/\n/)) {
            if (!line.trim()) continue;
            this.emit("line", line);
            await appendFile(opts.logPath, `${line}\n`, "utf8").catch(() => undefined);
          }
        }
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", async (d) => {
        const text = d.toString();
        output += text;
        this.emit("line", text);
        await appendFile(opts.logPath, text, "utf8").catch(() => undefined);
      });

      child.on("error", (err) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", async (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        this.child = null;
        if (outputFormat === "text") {
          await appendFile(opts.logPath, output, "utf8").catch(() => undefined);
          this.emit("line", output);
        }
        resolve({ code: code ?? 1, output });
      });
    });
  }

  kill(): void {
    this.child?.kill("SIGTERM");
  }
}
