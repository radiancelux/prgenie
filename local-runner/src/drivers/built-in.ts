import { appendFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type {
  AgentDriver,
  AgentDriverHandle,
  AgentDriverRunOptions,
  AgentDriverRunResult,
} from "./driver-types.js";
import { binaryOnPath, escalatingKill } from "./driver-types.js";
import { WATCHDOG_CHILD_GRACE_MS } from "../runner-policy.js";

async function runSpawnedCli(
  binary: string,
  args: string[],
  opts: AgentDriverRunOptions,
  hooks: { onLine: (line: string) => void; appendLog: (text: string) => Promise<void> },
  outputFormat: "stream-json" | "text",
): Promise<{ result: Promise<AgentDriverRunResult>; handle: AgentDriverHandle }> {
  let child: ChildProcess | null = null;
  const handle = escalatingKill(() => child, WATCHDOG_CHILD_GRACE_MS);

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
    const handle = escalatingKill(() => child, WATCHDOG_CHILD_GRACE_MS);

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

function slowDryRunDelayMs(): number {
  const raw = process.env.PRGENIE_RUNNER_SLOW_MS?.trim();
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 2_500;
}

/** Test-only driver: dry-run with an async delay so restart tests can observe in-flight workers. */
export const slowDryRunDriver: AgentDriver = {
  id: "slow-dry-run",
  async start(opts, hooks) {
    const delay = slowDryRunDelayMs();
    await hooks.appendLog(
      `\n--- agent (${opts.driver.id}, ${opts.model}, stream-json, slow ${delay}ms) ---\n`,
    );
    let timer: NodeJS.Timeout | null = null;
    const sleep = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, delay);
    });
    opts.signal?.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
      },
      { once: true },
    );
    const handle = {
      kill: () => {
        if (timer) clearTimeout(timer);
      },
    };
    const result = sleep.then(async () => {
      const fake =
        `[dry-run] slow agent (${delay}ms) in ${opts.cwd}\n` + `${opts.prompt.slice(0, 120)}...\n`;
      await hooks.appendLog(fake);
      hooks.onLine(fake);
      hooks.onLine('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}');
      return { code: 0, output: fake };
    });
    return { handle, result };
  },
  steer(_prompt, hooks) {
    void hooks.appendLog("[steer] slow-dry-run: queued for next step.\n");
  },
};

const BUILT_IN: Record<string, AgentDriver> = {
  "cursor-agent": cursorAgentDriver,
  "claude-code": claudeCodeDriver,
  "local-model": localModelDriver,
  "slow-dry-run": slowDryRunDriver,
};

export function getAgentDriver(driverId: string): AgentDriver | null {
  return BUILT_IN[driverId] ?? null;
}

export function listBuiltInDriverIds(): string[] {
  return Object.keys(BUILT_IN);
}
