import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  GitBinaryError,
  PRGENIE_GIT_ENV,
  clearGitBinaryCache,
  formatGitMissingError,
  requireGitBinary,
  resolveGitBinary,
  windowsGitCandidates,
} from "./git.js";

afterEach(() => {
  clearGitBinaryCache();
  delete process.env[PRGENIE_GIT_ENV];
});

test("resolveGitBinary prefers PRGENIE_GIT when the path exists", () => {
  const pinned = path.join("/mock", "Tools", "git.exe");
  const exists = new Set([pinned]);
  const resolved = resolveGitBinary({
    env: { [PRGENIE_GIT_ENV]: pinned, PATH: "" },
    platform: "win32",
    pathEnv: "",
    existsSync: (p) => exists.has(p),
    bypassCache: true,
  });
  assert.equal(resolved, pinned);
});

test("resolveGitBinary returns null when PRGENIE_GIT points at a missing file", () => {
  const missing = path.join("/mock", "missing", "git.exe");
  const resolved = resolveGitBinary({
    env: { [PRGENIE_GIT_ENV]: missing, PATH: path.join("/mock", "nowhere") },
    platform: "win32",
    pathEnv: path.join("/mock", "nowhere"),
    existsSync: () => false,
    bypassCache: true,
  });
  assert.equal(resolved, null);
});

test("resolveGitBinary walks PATH like where/which (Windows git.exe)", () => {
  const gitDir = path.join("/mock", "bin");
  const gitExe = path.join(gitDir, "git.exe");
  const resolved = resolveGitBinary({
    env: { PATH: gitDir },
    platform: "win32",
    pathEnv: gitDir,
    existsSync: (p) => p === gitExe,
    bypassCache: true,
  });
  assert.equal(resolved, gitExe);
});

test("resolveGitBinary falls back to Program Files Git\\cmd\\git.exe", () => {
  const pf = "C:\\Program Files";
  const known = path.join(pf, "Git", "cmd", "git.exe");
  const resolved = resolveGitBinary({
    env: { PATH: "", ProgramFiles: pf, "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    platform: "win32",
    pathEnv: "",
    existsSync: (p) => p === known,
    bypassCache: true,
  });
  assert.equal(resolved, known);
});

test("resolveGitBinary skips Windows well-known paths on non-Windows", () => {
  const pf = "C:\\Program Files";
  const pfGit = path.join(pf, "Git", "cmd", "git.exe");
  const resolved = resolveGitBinary({
    env: { PATH: "", ProgramFiles: pf },
    platform: "linux",
    pathEnv: "",
    existsSync: (p) => p === pfGit,
    bypassCache: true,
  });
  assert.equal(resolved, null);
});

test("windowsGitCandidates lists cmd then bin under Program Files", () => {
  const candidates = windowsGitCandidates({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: path.join("/mock", "AppData", "Local"),
  });
  assert.equal(candidates[0], path.join("C:\\Program Files", "Git", "cmd", "git.exe"));
  assert.ok(candidates.some((c) => c.includes(path.join("Git", "bin", "git.exe"))));
  assert.ok(candidates.some((c) => c.includes("AppData")));
});

test("requireGitBinary throws a Windows install hint when missing", () => {
  assert.throws(
    () =>
      requireGitBinary({
        env: { PATH: "" },
        platform: "win32",
        pathEnv: "",
        existsSync: () => false,
        bypassCache: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GitBinaryError);
      assert.match(err.message, /Git for Windows/);
      assert.match(err.message, new RegExp(PRGENIE_GIT_ENV));
      return true;
    },
  );
});

test("formatGitMissingError mentions PRGENIE_GIT on all platforms", () => {
  assert.match(formatGitMissingError("linux"), new RegExp(PRGENIE_GIT_ENV));
  assert.match(formatGitMissingError("win32"), /git-scm\.com\/download\/win/);
});

test("resolveGitBinary caches the live process result", () => {
  clearGitBinaryCache();
  const first = resolveGitBinary();
  assert.ok(first);
  assert.equal(resolveGitBinary(), first);
});
