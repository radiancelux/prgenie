import { appendFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type {
  AgentDriver,
  AgentDriverHandle,
  AgentDriverRunOptions,
  AgentDriverRunResult,
} from "./driver-types.js";
import { binaryOnPath } from "./driver-types.js";

async function runSpawnedCli(
  binary: string,
  args: string[],
  opts: AgentDriverRunOptions,
  hooks: { onLine: (line: string) => void; appendLog: (text: string) => Promise<void> },
  outputFormat: "stream-json" | "text",
): Promise<{ result: Promise<AgentDriverRunResult>; handle: AgentDriverHandle }> {
  let child: ChildProcess | null = null;
  const handle: AgentDriverHandle = {
    kill: () => child?.kill("SIGTERM"),
  };

  const result = new Promise<AgentDriverRunResult>((resolve, reject) => {
    child = spawn(binary, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onAbort = () => handle.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let output = "";

    const handleChunk = async (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (outputFormat === "stream-json") {
        for (const line of text.split(/\n/)) {
          if (!line.trim()) continue;
          hooks.onLine(line);
          await hooks.appendLog(`${line}\n`);
        }
      } else {
        for (const line of text.split(/\n/)) {
          if (!line.trim()) continue;
          hooks.onLine(line);
        }
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", async (d) => {
      const text = d.toString();
      output += text;
      hooks.onLine(text);
      await hooks.appendLog(text);
    });

    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", async (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      child = null;
      if (outputFormat === "text") {
        await hooks.appendLog(output);
        hooks.onLine(output);
      }
      resolve({ code: code ?? 1, output });
    });
  });

  return { result, handle };
}

export const cursorAgentDriver: AgentDriver = {
  id: "cursor-agent",
  async start(opts, hooks) {
    const binary = opts.driver.binary?.trim() || "cursor-agent";
    if (!opts.dryRun && !(await binaryOnPath(binary))) {
      throw new Error(`Driver "${opts.driver.id}": binary not found: ${binary}`);
    }
    const outputFormat = opts.outputFormat ?? "stream-json";
    await hooks.appendLog(`\n--- agent (${opts.driver.id}, ${opts.model}, ${outputFormat}) ---\n`);

    if (opts.dryRun) {
      const fake =
        `[dry-run] ${binary} would run in ${opts.cwd}\n` + `${opts.prompt.slice(0, 200)}...\n`;
      await hooks.appendLog(fake);
      hooks.onLine(fake);
      return {
        handle: { kill: () => undefined },
        result: Promise.resolve({ code: 0, output: fake }),
      };
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
    return runSpawnedCli(binary, args, opts, hooks, outputFormat);
  },
  steer(_prompt, hooks) {
    void hooks.appendLog(
      "[steer] cursor-agent does not support mid-run steer; queued for next step.\n",
    );
  },
};

/** Claude Code CLI adapter — see docs/drivers.md */
export const claudeCodeDriver: AgentDriver = {
  id: "claude-code",
  async start(opts, hooks) {
    const binary = opts.driver.binary?.trim() || "claude";
    if (!opts.dryRun && !(await binaryOnPath(binary))) {
      throw new Error(`Driver "${opts.driver.id}": binary not found: ${binary}`);
    }
    const outputFormat = opts.outputFormat ?? "stream-json";
    await hooks.appendLog(`\n--- agent (${opts.driver.id}, ${opts.model}, ${outputFormat}) ---\n`);

    if (opts.dryRun) {
      const fake = `[dry-run] ${binary} would run in ${opts.cwd}\n`;
      await hooks.appendLog(fake);
      hooks.onLine(fake);
      return {
        handle: { kill: () => undefined },
        result: Promise.resolve({ code: 0, output: fake }),
      };
    }

    const args = [
      "-p",
      opts.prompt,
      "--model",
      opts.model,
      "--output-format",
      outputFormat,
      "--dangerously-skip-permissions",
    ];
    return runSpawnedCli(binary, args, opts, hooks, outputFormat);
  },
  steer(_prompt, hooks) {
    void hooks.appendLog(
      "[steer] claude-code does not support mid-run steer; queued for next step.\n",
    );
  },
};

export const localModelDriver: AgentDriver = {
  id: "local-model",
  async start(opts, hooks) {
    const binary = opts.driver.binary?.trim() || "ollama";
    if (!opts.dryRun && !(await binaryOnPath(binary))) {
      throw new Error(`Driver "${opts.driver.id}": binary not found: ${binary}`);
    }
    const endpoint = opts.driver.endpoint?.trim() || "http://127.0.0.1:11434";
    await hooks.appendLog(
      `\n--- agent (${opts.driver.id}, ${opts.model}, text @ ${endpoint}) ---\n`,
    );

    if (opts.dryRun) {
      const fake = `[dry-run] ${binary} run ${opts.model} in ${opts.cwd}\n`;
      await hooks.appendLog(fake);
      hooks.onLine(fake);
      return {
        handle: { kill: () => undefined },
        result: Promise.resolve({ code: 0, output: fake }),
      };
    }

    const env = { ...process.env, OLLAMA_HOST: endpoint.replace(/\/$/, "") };
    const args = ["run", opts.model, opts.prompt];
    let child: ChildProcess | null = null;
    const handle: AgentDriverHandle = { kill: () => child?.kill("SIGTERM") };

    const result = new Promise<AgentDriverRunResult>((resolve, reject) => {
      child = spawn(binary, args, {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onAbort = () => handle.kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let output = "";
      const onData = async (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        for (const line of text.split(/\n/)) {
          if (!line.trim()) continue;
          hooks.onLine(line);
          await hooks.appendLog(`${line}\n`);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (err) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        child = null;
        resolve({ code: code ?? 1, output });
      });
    });

    return { result, handle };
  },
  steer(_prompt, hooks) {
    void hooks.appendLog(
      "[steer] local-model does not support mid-run steer; queued for next step.\n",
    );
  },
};

const BUILT_IN: Record<string, AgentDriver> = {
  "cursor-agent": cursorAgentDriver,
  "claude-code": claudeCodeDriver,
  "local-model": localModelDriver,
};

export function getAgentDriver(driverId: string): AgentDriver | null {
  return BUILT_IN[driverId] ?? null;
}

export function listBuiltInDriverIds(): string[] {
  return Object.keys(BUILT_IN);
}
