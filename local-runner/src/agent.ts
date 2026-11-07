import { appendFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { DriverEntry } from "./settings.js";
import type { AgentDriverRunOptions, AgentDriverRunResult } from "./drivers/driver-types.js";
import { getAgentDriver } from "./drivers/built-in.js";

export type { AgentDriverRunOptions, AgentDriverRunResult };

export interface AgentRunOptions extends Omit<AgentDriverRunOptions, "driver"> {
  driverId: string;
  driverEntry: DriverEntry;
}

export class AgentRunner extends EventEmitter {
  private killFn: (() => void) | null = null;

  async run(opts: AgentRunOptions): Promise<AgentDriverRunResult> {
    const driver = getAgentDriver(opts.driverId);
    if (!driver) {
      throw new Error(`Unknown agent driver: ${opts.driverId}`);
    }

    const hooks = {
      onLine: (line: string) => this.emit("line", line),
      appendLog: (text: string) => appendFile(opts.logPath, text, "utf8").catch(() => undefined),
    };

    const { result, handle } = await driver.start({ ...opts, driver: opts.driverEntry }, hooks);
    const kill = () => handle.kill();
    this.killFn = kill;
    try {
      return await result;
    } finally {
      // An abandoned run can settle after its retry started; keep the retry's kill hook.
      if (this.killFn === kill) this.killFn = null;
    }
  }

  kill(): void {
    this.killFn?.();
  }
}
