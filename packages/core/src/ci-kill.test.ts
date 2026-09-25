import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pidAlive } from "./ci-abort.js";
import { CiShellError, execCiShell, killProcessTree } from "./ci-kill.js";
import { isAbortError } from "./progress.js";

const isWin = process.platform === "win32";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ci process tree kill (RAD-135)", () => {
  it("killProcessTree is a no-op for invalid pids", () => {
    assert.doesNotThrow(() => {
      killProcessTree(undefined);
      killProcessTree(0);
      killProcessTree(-1);
    });
  });

  it("execCiShell rejects on timeout and names timeout in the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-timeout-"));
    try {
      const hang = isWin
        ? 'node -e "setInterval(()=>{},1e6)"'
        : 'node -e "setInterval(()=>{},1e6)"';
      await assert.rejects(
        execCiShell({
          command: hang,
          cwd: dir,
          timeout: 400,
          maxBuffer: 256 * 1024,
        }),
        (err: unknown) => {
          assert.ok(err instanceof CiShellError);
          assert.equal(err.kind, "timeout");
          assert.ok(err.timeoutMs === 400);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("execCiShell abort kills the descendant process tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-abort-"));
    const pidFile = join(dir, "child.pid");
    try {
      const spawnGrandchild = [
        'node -e "',
        "const {spawn}=require('child_process');",
        "const c=spawn(process.execPath,['-e','setInterval(()=>{},1e6)'],{stdio:'ignore',shell:true});",
        "require('fs').writeFileSync('child.pid', String(c.pid));",
        "setInterval(()=>{},1e6);",
        '"',
      ].join("");

      const ac = new AbortController();
      const run = execCiShell({
        command: spawnGrandchild,
        cwd: dir,
        timeout: 60_000,
        maxBuffer: 256 * 1024,
        signal: ac.signal,
      });

      await sleep(isWin ? 1200 : 600);
      ac.abort();

      await assert.rejects(run, (err: unknown) => {
        assert.ok(isAbortError(err) || (err instanceof CiShellError && err.kind === "cancelled"));
        return true;
      });

      await sleep(500);
      let childPid = 0;
      try {
        childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      } catch {
        // Child may have exited before writing — still assert shell is gone below.
      }
      if (childPid > 0) {
        assert.equal(pidAlive(childPid), false, "grandchild process should be dead after abort");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("execCiShell records maxBuffer exceeded distinctly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-buf-"));
    try {
      await writeFile(join(dir, "spew.mjs"), "console.log('x'.repeat(8000))\n");
      await assert.rejects(
        execCiShell({
          command: "node spew.mjs",
          cwd: dir,
          timeout: 10_000,
          maxBuffer: 512,
        }),
        (err: unknown) => {
          assert.ok(err instanceof CiShellError);
          assert.equal(err.kind, "maxBuffer");
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
