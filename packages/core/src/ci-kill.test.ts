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

/** Poll until a descendant pid file exists and the process is alive. */
async function waitForLiveDescendant(pidFile: string, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (pid > 0 && pidAlive(pid)) return pid;
    } catch {
      // pid file not written yet
    }
    await sleep(100);
  }
  assert.fail(`descendant pid never became alive (expected ${pidFile})`);
}

async function writeSpawnDescendantScript(dir: string, pidFileName: string): Promise<string> {
  const script = join(dir, "spawn-descendant.cjs");
  await writeFile(
    script,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], {",
      "  stdio: 'ignore',",
      "  detached: false,",
      "});",
      `fs.writeFileSync('${pidFileName}', String(worker.pid));`,
      "setInterval(() => {}, 1e6);",
    ].join("\n"),
  );
  return script;
}

async function cleanupDescendant(dir: string, pid: number | undefined): Promise<void> {
  if (pid && pid > 0 && pidAlive(pid)) {
    killProcessTree(pid);
    await sleep(isWin ? 500 : 200);
  }
  await rm(dir, { recursive: true, force: true });
}

describe("ci process tree kill (RAD-135)", () => {
  it("killProcessTree is a no-op for invalid pids", () => {
    assert.doesNotThrow(() => {
      killProcessTree(undefined);
      killProcessTree(0);
      killProcessTree(-1);
    });
  });

  it("execCiShell timeout kills a live descendant process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-timeout-"));
    const pidFile = join(dir, "child.pid");
    let childPid = 0;
    try {
      await writeSpawnDescendantScript(dir, "child.pid");
      let runErr: unknown;
      const run = execCiShell({
        command: "node spawn-descendant.cjs",
        cwd: dir,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      }).catch((err) => {
        runErr = err;
      });

      childPid = await waitForLiveDescendant(pidFile);
      await run;

      assert.ok(runErr instanceof CiShellError, "expected timeout CiShellError");
      assert.equal(runErr.kind, "timeout");
      assert.equal(runErr.timeoutMs, 5000);

      await sleep(isWin ? 800 : 400);
      assert.equal(pidAlive(childPid), false, "descendant must be dead after timeout kill");
    } finally {
      await cleanupDescendant(dir, childPid);
    }
  });

  it("execCiShell abort kills a live descendant process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-abort-"));
    const pidFile = join(dir, "child.pid");
    let childPid = 0;
    try {
      await writeSpawnDescendantScript(dir, "child.pid");
      const ac = new AbortController();
      let runErr: unknown;
      const run = execCiShell({
        command: "node spawn-descendant.cjs",
        cwd: dir,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        signal: ac.signal,
      }).catch((err) => {
        runErr = err;
      });

      childPid = await waitForLiveDescendant(pidFile);
      ac.abort();
      await run;

      assert.ok(
        isAbortError(runErr) || (runErr instanceof CiShellError && runErr.kind === "cancelled"),
        "expected abort/cancel error",
      );

      await sleep(isWin ? 800 : 400);
      assert.equal(pidAlive(childPid), false, "descendant must be dead after abort kill");
    } finally {
      await cleanupDescendant(dir, childPid);
    }
  });

  it("execCiShell maxBuffer is per stream (stdout and stderr each get the limit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-buf-"));
    try {
      // ~395 KiB per stream (~790 KiB combined) — under 512 KiB each, over 512 KiB combined.
      await writeFile(
        join(dir, "dual-spew.mjs"),
        [
          "const line = 'x'.repeat(580);",
          "for (let i = 0; i < 680; i++) console.log(line);",
          "for (let i = 0; i < 680; i++) console.error(line);",
        ].join("\n"),
      );
      const result = await execCiShell({
        command: "node dual-spew.mjs",
        cwd: dir,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      });
      assert.ok(result.stdout.length > 0);
      assert.ok(result.stderr.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("execCiShell finishes after pipe drain when stdout never closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prgenie-ci-kill-pipe-"));
    try {
      await writeFile(
        join(dir, "hang-pipe.mjs"),
        [
          "setInterval(() => {",
          "  try { process.stdout.write('x'); } catch {}",
          "}, 100);",
          "setInterval(() => {}, 1e9);",
        ].join("\n"),
      );
      const drainMs = 400;
      const started = Date.now();
      let childPid = 0;
      await assert.rejects(
        execCiShell({
          command: "node hang-pipe.mjs",
          cwd: dir,
          timeout: 300,
          maxBuffer: 256 * 1024,
          pipeCloseWaitMs: drainMs,
          killProcessTreeFn: (pid) => {
            childPid = pid ?? 0;
            return { ok: true };
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof CiShellError);
          assert.equal(err.kind, "timeout");
          assert.ok(
            err.notes.some((n) => n.includes("descendants may survive")),
            `expected pipe-drain note, got ${JSON.stringify(err.notes)}`,
          );
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < 300 + drainMs + 2000,
        `should finish within timeout + drain window, took ${elapsed}ms`,
      );
      if (childPid > 0) killProcessTree(childPid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("killProcessTree returns ok for invalid or already-dead pids", () => {
    assert.deepEqual(killProcessTree(undefined), { ok: true });
    assert.deepEqual(killProcessTree(0), { ok: true });
    assert.deepEqual(killProcessTree(-1), { ok: true });
    assert.deepEqual(killProcessTree(9_999_999), { ok: true });
  });

  it("execCiShell records maxBuffer exceeded distinctly on a single stream", async () => {
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
