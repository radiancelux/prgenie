import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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

export function formatInitReport(result: InitResult): string {
  const lines = [
    "PR Genie runner data directory ready.",
    `  data dir: ${result.dataDir}`,
    `  token file: ${result.tokenFile}`,
  ];
  if (result.createdToken) {
    lines.push(
      "",
      "For HTTP dashboard / serve, export the token (keep it secret):",
      `  export PRGENIE_RUNNER_TOKEN="$(cat ${result.tokenFile})"`,
      "",
      "Stdio MCP (Cursor, VS Code, Claude Desktop) does not need the token.",
      "Optional:",
      `  export PRGENIE_RUNNER_DATA_DIR=${JSON.stringify(result.dataDir)}`,
    );
  } else {
    lines.push("", "Existing token file left unchanged (use --force-token to rotate).");
  }
  lines.push("", "Next: prgenie doctor");
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

export function cursorMcpJsonSnippet(): string {
  return clientMcpSnippet("npx", ["-y", "prgenie", "mcp"]);
}

export function vscodeMcpJsonSnippet(): string {
  return `${JSON.stringify(
    {
      servers: {
        [RUNNER_MCP_SERVER_ID]: {
          type: "stdio",
          command: "npx",
          args: ["-y", "prgenie", "mcp"],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function claudeCodeMcpAddCommand(): string {
  return `claude mcp add --scope user ${RUNNER_MCP_SERVER_ID} -- npx -y prgenie mcp\n`;
}
