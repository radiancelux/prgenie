/**
 * Process-local seeded git fixture templates for unit tests.
 *
 * ## Isolation rules
 *
 * - Each `createTempGitRepo()` call receives a **unique** directory (`mkdtemp` suffix).
 *   Never share a working tree across parallel tests or sequential cases.
 * - Templates live under the OS temp dir, scoped to **this process** (PID in the path).
 *   There is no permanent cross-process disk cache (no `.cache/git-fixture`).
 *   Template directories are removed on process exit (best effort, sync).
 * - After seeding, the template repo is **read-only** — tests only `clone` from it.
 * - Clones are independent; commits/branches in one clone do not affect others.
 * - Optional `node_modules` junctions belong in the **clone**, not the template.
 *   Do not run `pnpm install` inside fixtures.
 *
 * ## Fail closed
 *
 * - `FIXTURE_TEMPLATE_SCHEMA` mismatch invalidates and rebuilds the template.
 * - Corrupt templates (missing schema, bad clone) trigger one rebuild then retry.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "./git.js";

/** Bump when the seeded template layout changes (invalidates process-local templates). */
export const FIXTURE_TEMPLATE_SCHEMA = 1;

/** Local identity on every clone (matches legacy per-test `git init` helpers). */
export const FIXTURE_USER_EMAIL = "test@example.com";
export const FIXTURE_USER_NAME = "Test User";

const SCHEMA_FILE = ".prgenie-git-fixture-schema";

export type GitFixtureTemplateId = "basic" | "loop-ci";

type TemplateSeed = {
  commitMessage: string;
  seed: (dir: string) => Promise<void>;
};

const TEMPLATE_SEEDS: Record<GitFixtureTemplateId, TemplateSeed> = {
  basic: {
    commitMessage: "Initial commit",
    seed: async (dir) => {
      await writeFile(join(dir, "README.md"), "# Test\n");
    },
  },
  "loop-ci": {
    commitMessage: "init",
    seed: async (dir) => {
      await writeFile(join(dir, "README.md"), "hi\n");
      await writeFile(
        join(dir, "package.json"),
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
    },
  },
};

/** Process-local template paths (template id → absolute repo path). */
const templatePaths = new Map<GitFixtureTemplateId, string>();

let exitCleanupRegistered = false;

function syncRemoveAllTemplates(): void {
  for (const path of templatePaths.values()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best effort on process exit
    }
  }
  templatePaths.clear();
}

function registerProcessExitTemplateCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", syncRemoveAllTemplates);
}

export type CreateTempGitRepoOptions = {
  /** Temp directory prefix (must end with `-` or `_` for mkdtemp). */
  prefix?: string;
  /** Seeded template to clone (default `basic`). */
  template?: GitFixtureTemplateId;
};

async function readTemplateSchema(templatePath: string): Promise<number | null> {
  try {
    const raw = await readFile(join(templatePath, SCHEMA_FILE), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function templateIsValid(templatePath: string): Promise<boolean> {
  const schema = await readTemplateSchema(templatePath);
  return schema === FIXTURE_TEMPLATE_SCHEMA;
}

async function invalidateTemplate(id: GitFixtureTemplateId): Promise<void> {
  const cached = templatePaths.get(id);
  if (cached) {
    await rm(cached, { recursive: true, force: true }).catch(() => undefined);
    templatePaths.delete(id);
  }
}

async function buildTemplate(id: GitFixtureTemplateId): Promise<string> {
  const spec = TEMPLATE_SEEDS[id];
  const dir = join(
    tmpdir(),
    `prgenie-git-tpl-${process.pid}-${id}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", FIXTURE_USER_EMAIL]);
  await git(dir, ["config", "user.name", FIXTURE_USER_NAME]);
  await writeFile(join(dir, SCHEMA_FILE), String(FIXTURE_TEMPLATE_SCHEMA));
  await spec.seed(dir);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", spec.commitMessage]);
  return dir;
}

/** Ensure a process-local seeded template exists for `id`. */
export async function ensureGitFixtureTemplate(id: GitFixtureTemplateId): Promise<string> {
  const cached = templatePaths.get(id);
  if (cached && (await templateIsValid(cached))) {
    return cached;
  }
  await invalidateTemplate(id);
  registerProcessExitTemplateCleanup();
  const built = await buildTemplate(id);
  templatePaths.set(id, built);
  return built;
}

async function finalizeClone(dest: string): Promise<void> {
  await git(dest, ["reset", "--hard", "HEAD"]);
  await git(dest, ["clean", "-fd"]);
  await git(dest, ["config", "user.email", FIXTURE_USER_EMAIL]);
  await git(dest, ["config", "user.name", FIXTURE_USER_NAME]);
  await git(dest, ["remote", "remove", "origin"], { allowFail: true });
  await git(dest, ["branch", "--unset-upstream", "main"], { allowFail: true });
}

async function cloneFromTemplate(templatePath: string, dest: string): Promise<void> {
  const parent = dirname(dest);
  const name = basename(dest);
  await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  await git(parent, ["clone", templatePath, name]);
  await finalizeClone(dest);
}

/**
 * Create an isolated temp git repo by cloning a process-local seeded template.
 * Prefer this over per-test `git init` for suites that only need a clean main + initial commit.
 */
export async function createTempGitRepo(options: CreateTempGitRepoOptions = {}): Promise<string> {
  const templateId = options.template ?? "basic";
  const prefix = options.prefix ?? "prgenie-git-fix-";
  const dest = await mkdtemp(join(tmpdir(), prefix));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const templatePath = await ensureGitFixtureTemplate(templateId);
      await cloneFromTemplate(templatePath, dest);
      return dest;
    } catch (err) {
      await invalidateTemplate(templateId);
      if (attempt === 1) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `createTempGitRepo: failed to clone template "${templateId}" after rebuild: ${detail}`,
          { cause: err },
        );
      }
    }
  }

  throw new Error("createTempGitRepo: unreachable");
}

/** Test-only: drop cached templates so schema-miss / rebuild tests start fresh. */
export function clearGitFixtureTemplatesForTest(): void {
  syncRemoveAllTemplates();
}

/** Test-only: same sync removal used on process exit. */
export function removeGitFixtureTemplatesSyncForTest(): void {
  syncRemoveAllTemplates();
}

/** Test-only: path of the cached template for `id`, if built. */
export function getGitFixtureTemplatePathForTest(id: GitFixtureTemplateId): string | undefined {
  return templatePaths.get(id);
}
