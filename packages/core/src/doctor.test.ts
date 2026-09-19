import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { formatDoctorReport, runDoctor } from "./doctor.js";

let dir = "";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function initRepo(name: string): Promise<string> {
  const repo = path.join(dir, name);
  await mkdir(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@prgenie.ai"], repo);
  git(["config", "user.name", "PR Genie Test"], repo);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);
  return repo;
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-doctor-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("doctor fails mcp-duplicate when workspace and plugin both name prgenie", async () => {
  const repo = await initRepo("dup");
  await mkdir(path.join(repo, ".cursor"), { recursive: true });
  await writeFile(
    path.join(repo, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: { prgenie: { command: "node", args: ["./server.cjs"] } },
    }),
  );
  const home = path.join(dir, "home-dup");
  const plugin = path.join(home, ".cursor", "plugins", "local", "prgenie");
  await mkdir(path.join(plugin, "mcp"), { recursive: true });
  await writeFile(path.join(plugin, "mcp", "server.cjs"), "/* mcp */\n");
  await writeFile(
    path.join(plugin, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        prgenie: { type: "stdio", command: process.execPath, args: ["./mcp/server.cjs"] },
      },
    }),
  );

  const report = await runDoctor(repo, { home });
  const dup = report.checks.find((c) => c.id === "mcp-duplicate");
  assert.ok(dup);
  assert.equal(dup.ok, false);
  assert.match(dup.summary, /both register "prgenie"/);
  assert.match(formatDoctorReport(report), /mcp-duplicate/);
});

test("doctor passes mcp-duplicate when workspace is prgenie-dev", async () => {
  const repo = await initRepo("dev-name");
  await mkdir(path.join(repo, ".cursor"), { recursive: true });
  await writeFile(
    path.join(repo, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: { "prgenie-dev": { command: "node", args: ["./server.cjs"] } },
    }),
  );
  const home = path.join(dir, "home-dev");
  const plugin = path.join(home, ".cursor", "plugins", "local", "prgenie");
  await mkdir(path.join(plugin, "mcp"), { recursive: true });
  await writeFile(path.join(plugin, "mcp", "server.cjs"), "/* mcp */\n");
  await writeFile(
    path.join(plugin, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        prgenie: { type: "stdio", command: process.execPath, args: ["./mcp/server.cjs"] },
      },
    }),
  );

  const report = await runDoctor(repo, { home });
  const dup = report.checks.find((c) => c.id === "mcp-duplicate");
  assert.ok(dup);
  assert.equal(dup.ok, true);
});

test("doctor fails mcp-config on UTF-8 BOM and unresolved PLUGIN_ROOT", async () => {
  const repo = await initRepo("bom");
  const home = path.join(dir, "home-bom");
  const plugin = path.join(home, ".cursor", "plugins", "local", "prgenie");
  await mkdir(path.join(plugin, "mcp"), { recursive: true });
  await writeFile(path.join(plugin, "mcp", "server.cjs"), "/* mcp */\n");
  await writeFile(
    path.join(plugin, "mcp.json"),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        '{"mcpServers":{"prgenie":{"command":"node","args":["${PLUGIN_ROOT}/mcp/server.cjs"]}}}',
      ),
    ]),
  );

  const report = await runDoctor(repo, { home });
  const cfg = report.checks.find((c) => c.id === "mcp-config");
  assert.ok(cfg);
  assert.equal(cfg.ok, false);
  assert.match(cfg.summary, /BOM|PLUGIN_ROOT/);
});
