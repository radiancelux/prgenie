import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  computeCiInputHash,
  getCachedResult,
  recordCheckPass,
  clearCiCache,
  loadCiCache,
} from "./ci-cache.js";

const execAsync = promisify(exec);

async function initTestRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-test-"));
  await execAsync("git init", { cwd: tmp });
  await execAsync('git config user.email "test@test.com"', { cwd: tmp });
  await execAsync('git config user.name "Test"', { cwd: tmp });

  // Create package.json with scripts
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: {
        "format:check": "exit 0",
        lint: "exit 0",
        typecheck: "exit 0",
        test: "exit 0",
        build: "exit 0",
      },
    }),
  );

  // Create a test file
  await writeFile(join(tmp, "test.txt"), "initial content\n");

  // Commit initial files
  await execAsync("git add .", { cwd: tmp });
  await execAsync('git commit -m "Initial commit"', { cwd: tmp });

  return tmp;
}

describe("ci-cache", () => {
  describe("computeCiInputHash", () => {
    it("computes a hash for a git repository", async () => {
      const repo = await initTestRepo();
      try {
        const hash = await computeCiInputHash(repo);
        assert.ok(hash, "Should compute a hash");
        assert.equal(typeof hash, "string");
        assert.equal(hash.length, 64); // SHA-256 hex
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns same hash for unchanged repository", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);
        const hash2 = await computeCiInputHash(repo);
        assert.equal(hash1, hash2, "Hash should be deterministic");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns different hash when file content changes", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);

        // Modify and commit a file
        await writeFile(join(repo, "test.txt"), "changed content\n");
        await execAsync("git add .", { cwd: repo });
        await execAsync('git commit -m "Change content"', { cwd: repo });

        const hash2 = await computeCiInputHash(repo);
        assert.notEqual(hash1, hash2, "Hash should change when content changes");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns different hash when new file is added", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);

        // Add a new file
        await writeFile(join(repo, "new.txt"), "new file\n");
        await execAsync("git add .", { cwd: repo });
        await execAsync('git commit -m "Add new file"', { cwd: repo });

        const hash2 = await computeCiInputHash(repo);
        assert.notEqual(hash1, hash2, "Hash should change when files are added");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns different hash when file is deleted", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);

        // Delete a file
        await execAsync("git rm test.txt", { cwd: repo });
        await execAsync('git commit -m "Delete file"', { cwd: repo });

        const hash2 = await computeCiInputHash(repo);
        assert.notEqual(hash1, hash2, "Hash should change when files are deleted");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns different hash when package.json scripts change", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);

        // Modify scripts in package.json
        await writeFile(
          join(repo, "package.json"),
          JSON.stringify({
            name: "test-repo",
            scripts: {
              "format:check": "exit 0",
              lint: "exit 1", // Changed from exit 0
              typecheck: "exit 0",
              test: "exit 0",
              build: "exit 0",
            },
          }),
        );
        await execAsync("git add .", { cwd: repo });
        await execAsync('git commit -m "Change scripts"', { cwd: repo });

        const hash2 = await computeCiInputHash(repo);
        assert.notEqual(hash1, hash2, "Hash should change when scripts change");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns same hash when untracked files are added (working tree changes)", async () => {
      const repo = await initTestRepo();
      try {
        const hash1 = await computeCiInputHash(repo);

        // Add untracked file (not committed)
        await writeFile(join(repo, "untracked.txt"), "untracked content\n");

        const hash2 = await computeCiInputHash(repo);
        assert.equal(
          hash1,
          hash2,
          "Hash should not change for untracked files (only committed content matters)",
        );
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("returns null for non-git directory", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-nogit-"));
      try {
        await writeFile(
          join(tmp, "package.json"),
          JSON.stringify({
            name: "test-repo",
            scripts: {},
          }),
        );

        const hash = await computeCiInputHash(tmp);
        assert.equal(hash, null, "Should return null for non-git directory");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("cache operations", () => {
    it("records and retrieves a successful check", async () => {
      const repo = await initTestRepo();
      try {
        // No cache initially
        const before = await getCachedResult(repo, "lint");
        assert.equal(before, null);

        // Record a pass
        await recordCheckPass(repo, "lint");

        // Should retrieve the cached result
        const after = await getCachedResult(repo, "lint");
        assert.ok(after);
        assert.equal(after.check, "lint");
        assert.ok(after.inputHash);
        assert.ok(after.passedAt);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("invalidates cache when file content changes", async () => {
      const repo = await initTestRepo();
      try {
        // Record a pass
        await recordCheckPass(repo, "lint");

        // Should be cached
        const cached1 = await getCachedResult(repo, "lint");
        assert.ok(cached1);

        // Modify and commit a file
        await writeFile(join(repo, "test.txt"), "changed\n");
        await execAsync("git add .", { cwd: repo });
        await execAsync('git commit -m "Change"', { cwd: repo });

        // Cache should be invalid
        const cached2 = await getCachedResult(repo, "lint");
        assert.equal(cached2, null, "Cache should be invalid after file change");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("maintains separate cache entries per check", async () => {
      const repo = await initTestRepo();
      try {
        // Record passes for different checks
        await recordCheckPass(repo, "lint");
        await recordCheckPass(repo, "test");

        // Both should be cached
        const lintCache = await getCachedResult(repo, "lint");
        const testCache = await getCachedResult(repo, "test");

        assert.ok(lintCache);
        assert.ok(testCache);
        assert.equal(lintCache.check, "lint");
        assert.equal(testCache.check, "test");

        // typecheck was not recorded - should not be cached
        const typecheckCache = await getCachedResult(repo, "typecheck");
        assert.equal(typecheckCache, null);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("clearCiCache removes all cached entries", async () => {
      const repo = await initTestRepo();
      try {
        // Record some passes
        await recordCheckPass(repo, "lint");
        await recordCheckPass(repo, "test");

        // Verify they're cached
        assert.ok(await getCachedResult(repo, "lint"));
        assert.ok(await getCachedResult(repo, "test"));

        // Clear cache
        await clearCiCache(repo);

        // Verify cache is empty
        assert.equal(await getCachedResult(repo, "lint"), null);
        assert.equal(await getCachedResult(repo, "test"), null);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("loadCiCache returns empty cache for non-existent file", async () => {
      const repo = await initTestRepo();
      try {
        const cache = await loadCiCache(repo);
        assert.deepEqual(cache, { checks: {} });
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it("handles corrupted cache file gracefully", async () => {
      const repo = await initTestRepo();
      try {
        // Record a valid entry
        await recordCheckPass(repo, "lint");

        // Corrupt the cache file
        const path = await import("node:path");
        const gitCommonDir = await import("./git.js").then((m) => m.gitCommonDir);
        const common = await gitCommonDir(repo);
        const cacheFile = path.join(common, "agent-console", "ci-cache", "cache.json");
        await writeFile(cacheFile, "{invalid json", "utf8");

        // Should handle gracefully and return null (cache miss)
        const cached = await getCachedResult(repo, "lint");
        assert.equal(cached, null);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  });

  describe("fail-closed behavior", () => {
    it("returns null when git operations fail", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-fail-"));
      try {
        // Create a directory that's not a git repo
        await writeFile(
          join(tmp, "package.json"),
          JSON.stringify({
            name: "test-repo",
            scripts: { lint: "exit 0" },
          }),
        );

        // Should fail closed with null (cache miss)
        const hash = await computeCiInputHash(tmp);
        assert.equal(hash, null);

        const cached = await getCachedResult(tmp, "lint");
        assert.equal(cached, null);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("does not record pass when hash computation fails", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-norecord-"));
      try {
        // Create a directory that's not a git repo
        await writeFile(
          join(tmp, "package.json"),
          JSON.stringify({
            name: "test-repo",
            scripts: { lint: "exit 0" },
          }),
        );

        // Try to record a pass - should fail gracefully
        await recordCheckPass(tmp, "lint");

        // Verify nothing was recorded (even if we later initialize git)
        await execAsync("git init", { cwd: tmp });
        await execAsync('git config user.email "test@test.com"', { cwd: tmp });
        await execAsync('git config user.name "Test"', { cwd: tmp });
        await execAsync("git add .", { cwd: tmp });
        await execAsync('git commit -m "Init"', { cwd: tmp });

        const cached = await getCachedResult(tmp, "lint");
        assert.equal(cached, null, "Should not have recorded pass in non-git repo");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
