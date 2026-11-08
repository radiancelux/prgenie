import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import {
  enrichNoPrGuardMessage,
  formatJobPreflightErrors,
  runJobStartPreflight,
} from "./job-preflight.js";
import { loadSettings } from "./settings.js";
import { runInit } from "./init.js";
import type { RunnerSettings } from "./settings.js";

describe("job start preflight", () => {
  let settings: RunnerSettings;

  before(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lr-pf-cfg-"));
    await runInit({ dataDir: dir });
    settings = await loadSettings(dir);
  });

  it("blocks real jobs when origin, gh, and driver are missing", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-pf-repo-"));
    const target = {
      ok: true as const,
      repoPath: repo,
      repoSlug: "demo",
      jobType: "code" as const,
    };
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "remote") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runJobStartPreflight(target, {}, settings, false, {
      git: gitImpl as never,
      ghAuthStatus: async () => "missing",
      binaryOnPath: async () => false,
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocking.some((i) => i.id === "origin-missing"));
    assert.ok(result.blocking.some((i) => i.id === "gh-missing"));
    assert.ok(result.blocking.some((i) => i.id === "driver-binary"));
    assert.match(formatJobPreflightErrors(result.blocking), /prgenie doctor/);
  });

  it("reports setup gaps as warnings on dry runs but still blocks missing repoPath", async () => {
    const target = {
      ok: true as const,
      repoPath: "/no/such/repo",
      repoSlug: "demo",
      jobType: "code" as const,
    };
    const missing = await runJobStartPreflight(target, { dryRun: true }, settings, true, {
      access: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.ok(missing.blocking.some((i) => i.id === "repo-missing"));

    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-pf-dry-"));
    const dry = await runJobStartPreflight(
      {
        ok: true,
        repoPath: repo,
        repoSlug: "demo",
        jobType: "code",
      },
      { dryRun: true },
      settings,
      true,
      {
        git: (async (_c: string, args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
          if (args[0] === "remote") return { code: 1, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        }) as never,
        ghAuthStatus: async () => "not_logged_in",
        binaryOnPath: async () => false,
      },
    );
    assert.equal(dry.blocking.length, 0);
    assert.ok(dry.warnings.length >= 3);
  });

  it("rejects a non-github.com origin even when owner/name parses", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-pf-gitlab-"));
    const result = await runJobStartPreflight(
      { ok: true, repoPath: repo, repoSlug: "demo", jobType: "code" },
      {},
      settings,
      false,
      {
        git: (async (_c: string, args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
          if (args[0] === "remote") {
            return { code: 0, stdout: "git@gitlab.com:acme/widgets.git\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        }) as never,
        ghAuthStatus: async () => "ok",
        binaryOnPath: async () => true,
      },
    );
    assert.ok(result.blocking.some((i) => i.id === "origin-not-github"));
  });

  it("enriches no-PR stuck text with likely causes", () => {
    const msg = enrichNoPrGuardMessage("No GitHub PR for branch — local-only diff guard", {
      hints: ['repo has no "origin" remote', "gh is not installed"],
    });
    assert.match(msg, /likely:/);
    assert.match(msg, /origin/);
    assert.match(msg, /prgenie doctor/);
  });
});
