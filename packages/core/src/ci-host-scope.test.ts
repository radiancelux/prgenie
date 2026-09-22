import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectMonorepoWideScript,
  eslintPathsFromChanged,
  hostScopeFailClosedReason,
  packageFiltersFromChanged,
  resolveCiCheckCommand,
} from "./ci-host-scope.js";

describe("detectMonorepoWideScript", () => {
  it("detects eslint . (and flag variants) as monorepo-wide", () => {
    assert.equal(detectMonorepoWideScript("eslint .")?.tool, "eslint");
    assert.equal(detectMonorepoWideScript("eslint ./")?.tool, "eslint");
    assert.equal(detectMonorepoWideScript("eslint . --max-warnings 0")?.tool, "eslint");
    assert.equal(detectMonorepoWideScript("pnpm exec eslint .")?.tool, "eslint");
    assert.equal(detectMonorepoWideScript("npx eslint --ext .ts,.tsx .")?.tool, "eslint");
  });

  it("does not treat already path-scoped eslint as monorepo-wide (RAD-105)", () => {
    assert.equal(
      detectMonorepoWideScript("eslint packages/core/src packages/cli/src packages/extension/src scripts"),
      null,
    );
  });

  it("detects turbo without --filter and pnpm -r", () => {
    assert.equal(detectMonorepoWideScript("turbo run lint")?.tool, "turbo");
    assert.equal(detectMonorepoWideScript("turbo run lint --filter=./apps/web"), null);
    assert.equal(detectMonorepoWideScript("pnpm -r lint")?.tool, "pnpm-recursive");
  });
});

describe("hostScopeFailClosedReason", () => {
  it("fail-closes on empty, config, or unknown paths", () => {
    assert.match(hostScopeFailClosedReason([]) ?? "", /no changed paths/);
    assert.match(hostScopeFailClosedReason(["package.json"]) ?? "", /config\/CI/);
    assert.match(hostScopeFailClosedReason(["assets/logo.png"]) ?? "", /uncertain/);
    assert.equal(hostScopeFailClosedReason(["apps/mobile/src/a.ts"]), null);
  });
});

describe("resolveCiCheckCommand host-repo fixtures", () => {
  const hostScripts = {
    lint: "eslint .",
    test: "exit 0",
    "format:check": "prettier --check .",
  };

  it("scopes eslint . to changed source paths and shows them in the command", () => {
    const resolved = resolveCiCheckCommand({
      check: "lint",
      cwd: "/tmp/host",
      changedPaths: ["apps/mobile/src/badge.ts", "README.md"],
      scripts: hostScripts,
    });
    assert.equal(resolved.hostScoped, true);
    assert.match(resolved.command, /^pnpm exec eslint /);
    assert.match(resolved.command, /apps\/mobile\/src\/badge\.ts/);
    assert.doesNotMatch(resolved.command, /(?:^|\s)\.(?:\s|$)/);
    assert.notEqual(resolved.command, "pnpm lint");
  });

  it("fail-closes to pnpm lint when config changes", () => {
    const resolved = resolveCiCheckCommand({
      check: "lint",
      cwd: "/tmp/host",
      changedPaths: ["eslint.config.mjs", "apps/mobile/src/badge.ts"],
      scripts: hostScripts,
    });
    assert.equal(resolved.hostScoped, false);
    assert.equal(resolved.command, "pnpm lint");
    assert.match(resolved.reason ?? "", /config\/CI/);
  });

  it("keeps prgenie-style already-scoped lint as pnpm lint", () => {
    const resolved = resolveCiCheckCommand({
      check: "lint",
      cwd: "/tmp/prgenie",
      changedPaths: ["packages/core/src/ci-select.ts"],
      scripts: {
        lint: "eslint packages/core/src packages/cli/src packages/extension/src scripts",
      },
    });
    assert.equal(resolved.hostScoped, false);
    assert.equal(resolved.command, "pnpm lint");
  });

  it("leaves package-scoped lint:core on RAD-105 commands", () => {
    const resolved = resolveCiCheckCommand({
      check: "lint:core",
      cwd: "/tmp/prgenie",
      changedPaths: ["packages/core/src/ci-select.ts"],
      scripts: hostScripts,
    });
    assert.equal(resolved.hostScoped, false);
    assert.equal(resolved.command, "pnpm exec eslint packages/core/src");
  });

  it("adds turbo --filter from package dirs", () => {
    const resolved = resolveCiCheckCommand({
      check: "lint",
      cwd: "/tmp/host",
      changedPaths: ["apps/mobile/src/a.ts", "packages/ui/src/b.ts"],
      scripts: { lint: "turbo run lint" },
    });
    assert.equal(resolved.hostScoped, true);
    assert.match(resolved.command, /--filter \.\/apps\/mobile/);
    assert.match(resolved.command, /--filter \.\/packages\/ui/);
  });

  it("maps eslint path helpers", () => {
    assert.deepEqual(eslintPathsFromChanged(["apps/a.ts", "README.md", "apps/a.png"]), [
      "apps/a.ts",
    ]);
    assert.deepEqual(packageFiltersFromChanged(["apps/mobile/src/x.ts", "docs/a.md"]), [
      "./apps/mobile",
    ]);
  });
});
