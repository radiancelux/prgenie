import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { prgenieCmd } from "./cli-invocation.js";
import { defaultDataDir, runnerTokenFile } from "./config.js";
import { ensureDataDirs } from "./store.js";

export interface InitResult {
  dataDir: string;
  tokenFile: string;
  createdToken: boolean;
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function runInit(options?: {
  dataDir?: string;
  forceToken?: boolean;
}): Promise<InitResult> {
  const dataDir = options?.dataDir?.trim() || defaultDataDir();
  await mkdir(dataDir, { recursive: true });
  await ensureDataDirs(dataDir);

  const tokenFile = runnerTokenFile(dataDir);
  let createdToken = false;
  try {
    await import("node:fs/promises").then((fs) => fs.access(tokenFile));
    if (options?.forceToken) {
      const token = generateToken();
      await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
      await chmod(tokenFile, 0o600);
      createdToken = true;
    }
  } catch {
    const token = generateToken();
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    try {
      await chmod(tokenFile, 0o600);
    } catch {
      // Windows may not support chmod the same way
    }
    createdToken = true;
  }

  return { dataDir, tokenFile, createdToken };
}

export function formatInitReport(result: InitResult, env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    "PR Genie runner data directory ready.",
    `  data dir: ${result.dataDir}`,
    `  token file: ${result.tokenFile}`,
  ];
  if (result.createdToken) {
    lines.push(
      "",
      `For HTTP dashboard / serve, \`${prgenieCmd("serve", env)}\` reads the token file automatically:`,
      `  ${result.tokenFile}`,
      "",
      ...(process.platform === "win32"
        ? [
            "Optional override (keep secret) — PowerShell:",
            `  $env:PRGENIE_RUNNER_TOKEN = Get-Content -Raw '${result.tokenFile.replace(/'/g, "''")}'`,
            "",
            "Git Bash: export PRGENIE_RUNNER_TOKEN=\"$(cat '" +
              result.tokenFile.replace(/'/g, "'\\''") +
              "')\"",
          ]
        : [
            "Optional override (keep secret):",
            `  export PRGENIE_RUNNER_TOKEN="$(cat ${result.tokenFile})"`,
          ]),
      "",
      "Stdio MCP (Cursor, VS Code, Claude Desktop) does not need the token.",
    );
  } else {
    lines.push("", "Existing token file left unchanged (use --force-token to rotate).");
  }
  lines.push("", `Next: ${prgenieCmd("doctor", env)}`);
  return `${lines.join("\n")}\n`;
}

/** Distinct from the Cursor plugin's `prgenie` steward MCP so both can be enabled together. */
export const RUNNER_MCP_SERVER_ID = "prgenie-runner";

export function clientMcpSnippet(command: string, args: string[]): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [RUNNER_MCP_SERVER_ID]: {
          type: "stdio",
          command,
          args,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export const CONFIG_CLIENT_IDS = ["cursor", "vscode", "claude-code", "claude-desktop"] as const;
export type ConfigClientId = (typeof CONFIG_CLIENT_IDS)[number];

export function mcpSpawnForConfig(useGlobal: boolean): { command: string; args: string[] } {
  if (useGlobal) {
    return { command: "prgenie", args: ["mcp"] };
  }
  return { command: "npx", args: ["-y", "prgenie", "mcp"] };
}

export function cursorMcpJsonSnippet(useGlobal = false): string {
  const { command, args } = mcpSpawnForConfig(useGlobal);
  return clientMcpSnippet(command, args);
}

export function claudeDesktopMcpJsonSnippet(useGlobal = false): string {
  const { command, args } = mcpSpawnForConfig(useGlobal);
  return `${JSON.stringify(
    {
      mcpServers: {
        [RUNNER_MCP_SERVER_ID]: {
          command,
          args,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function vscodeMcpJsonSnippet(useGlobal = false): string {
  const { command, args } = mcpSpawnForConfig(useGlobal);
  return `${JSON.stringify(
    {
      servers: {
        [RUNNER_MCP_SERVER_ID]: {
          type: "stdio",
          command,
          args,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function claudeCodeMcpAddCommand(useGlobal = false): string {
  const { command, args } = mcpSpawnForConfig(useGlobal);
  return `claude mcp add --scope user ${RUNNER_MCP_SERVER_ID} -- ${command} ${args.join(" ")}\n`;
}
