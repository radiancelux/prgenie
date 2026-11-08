import type { RunnerEngine } from "./engine.js";
import { loadSettings, saveSettings, toPublicSettings } from "./settings.js";
import {
  normalizeContinueJobArgs,
  normalizeStartJobArgs,
  parseSettingsPatch,
} from "./settings-validation.js";

type Json = Record<string, unknown>;

export const RUNNER_MCP_TOOLS = [
  {
    name: "start_job",
    description: "Start a local CLI runner job (implement → PR → review → fix loop).",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        remote: { type: "string" },
        branch: { type: "string" },
        promptFile: { type: "string" },
        reviewPromptFile: { type: "string" },
        fixPromptFile: { type: "string" },
        maxRounds: { type: "number" },
        model: {
          type: "string",
          description: "Model for every stage (legacy); a stageModels entry wins for its stage",
        },
        stageModels: {
          type: "object",
          description:
            "Per-stage models; each wins over model, Setup defaults and PRGENIE_RUNNER_MODEL. Fix defaults to auto on cursor-agent.",
          properties: {
            build: { type: "string" },
            review: { type: "string" },
            fix: { type: "string" },
          },
        },
        driver: {
          type: "string",
          description: "Agent driver id (cursor-agent, claude-code, local-model)",
        },
        dryRun: { type: "boolean" },
        ticketUrl: {
          type: "string",
          description: "Linear issue URL (optional; inferred from branch RAD-n when omitted)",
        },
        ticketUrls: {
          type: "array",
          items: { type: "string" },
          description:
            "Tickets the job covers (http(s) URLs, at most 10); ticketUrl, when set, stays primary",
        },
        linearIssue: {
          type: "string",
          description: "Linear issue id e.g. (optional; builds ticketUrl when set alone)",
        },
        jobType: {
          type: "string",
          enum: ["code", "docs"],
          description: "code (default) or docs for business/policy Markdown PRs",
        },
        profile: {
          type: "string",
          enum: ["code", "docs"],
          description: "Alias for jobType",
        },
        docsTemplate: {
          type: "string",
          enum: ["marketing", "policy", "research"],
          description: "Built-in docs implementor template (docs jobs)",
        },
        title: {
          type: "string",
          description:
            "Dashboard agent row label (optional; derived from Linear slug, prompt # heading, or branch)",
        },
        expectPr: {
          type: "boolean",
          description:
            "When false, skip PR review and finish approved if build succeeds with no GitHub PR (issues-only). Default true.",
        },
      },
      required: ["branch"],
    },
  },
  {
    name: "list_jobs",
    description:
      "List runner jobs (newest first). Merged PRs drop off the list after about one hour.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: {
          type: "boolean",
          description: "Also list archived (removed) jobs; they have archivedAt set",
        },
      },
    },
  },
  {
    name: "get_job",
    description: "Get job status and log tail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "steer_job",
    description: "Queue a follow-up prompt for the next agent step (or after current step).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, prompt: { type: "string" } },
      required: ["id", "prompt"],
    },
  },
  {
    name: "stop_job",
    description: "Request job stop (kills in-flight cursor-agent).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "archive_job",
    description:
      "Remove a finished job from the dashboard (moves it under archived/). Rejected while the job is running. Removes the worktree only when clean; otherwise keeps it and returns a warning.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "restore_job",
    description: "Restore an archived job back onto the dashboard.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "continue_job",
    description:
      "Run additional fix→review round(s) on a terminal job (approved, changes_remaining, stuck, stopped, failed, or interrupted). When the job has no PR yet, re-runs its build stage on the same branch/worktree instead (then opens a PR when ready).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        prompt: { type: "string" },
        promptFile: { type: "string" },
        extraRounds: {
          type: "number",
          description: "Default 1 (0 when resuming a pre-PR build)",
        },
        model: {
          type: "string",
          description:
            "Optional model override for the resumed stage: fix (default auto), or build on a pre-PR resume",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "restart_runner",
    description:
      "Graceful runner restart: HTTP server exits so you can rebuild/relaunch; in-flight jobs keep running in detached workers and are re-adopted on the next serve.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "settings",
    description:
      "Read runner settings (no arguments) or patch defaults/drivers/watchdog (same fields as PATCH /api/settings).",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "object", description: "Optional nested patch object" },
        expectedRevision: { type: "number" },
      },
    },
  },
] as const;

export const RUNNER_MCP_TOOL_NAMES = RUNNER_MCP_TOOLS.map((t) => t.name);

type ToolHandler = (engine: RunnerEngine, args: Json) => Promise<unknown>;

const RUNNER_TOOL_HANDLERS: Record<string, ToolHandler> = {
  start_job: (engine, args) => engine.startJob(normalizeStartJobArgs(args)),
  list_jobs: (engine, args) => engine.list({ includeArchived: args.includeArchived === true }),
  get_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const job = await engine.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  steer_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const prompt = String(args.prompt ?? "");
    const job = await engine.steer(id, prompt);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  stop_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const job = await engine.stop(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  archive_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const result = await engine.archive(id);
    if (!result.ok) throw new Error(`${result.error}: ${id}`);
    return result;
  },
  restore_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const result = await engine.restore(id);
    if (!result.ok) throw new Error(`${result.error}: ${id}`);
    return { ok: true, id: result.id, stage: result.job.stage };
  },
  continue_job: (engine, args) => engine.continueJob({ ...normalizeContinueJobArgs(args) }),
  restart_runner: async (engine) => engine.prepareRestart(),
  settings: async (engine, args) => {
    const dataDir = engine.config.dataDir;
    const hasPatch =
      args.patch !== undefined && args.patch !== null && typeof args.patch === "object";
    const topLevelKeys = Object.keys(args).filter((k) => k !== "patch");
    if (!hasPatch && topLevelKeys.length === 0) {
      return toPublicSettings(engine.config, await loadSettings(dataDir));
    }
    const patch = parseSettingsPatch((hasPatch ? (args.patch as Json) : args) as Json);
    const saved = await saveSettings(dataDir, patch);
    return toPublicSettings(engine.config, saved);
  },
};

export async function handleRunnerTool(
  engine: RunnerEngine,
  name: string,
  args: Json,
): Promise<unknown> {
  if (!isRunnerTool(name)) throw new Error(`unknown tool: ${name}`);
  return RUNNER_TOOL_HANDLERS[name](engine, args);
}

function isRunnerTool(name: string): boolean {
  return Object.hasOwn(RUNNER_TOOL_HANDLERS, name);
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const JSONRPC_TOOL_ERROR = -32000;

export type JsonRpcId = string | number | null;

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
};

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns `null` for notifications (no `id`): JSON-RPC 2.0 forbids replying to them.
 * Every other reply carries `jsonrpc: "2.0"` and echoes the request `id`.
 */
export async function handleMcpJsonRpc(
  engine: RunnerEngine,
  msg: unknown,
): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Invalid Request");
  }
  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: unknown };
  if (id === undefined) return null;
  if (typeof id !== "string" && typeof id !== "number") {
    return jsonRpcError(
      null,
      JSONRPC_INVALID_REQUEST,
      "Invalid Request: id must be string or number",
    );
  }
  if (typeof method !== "string") {
    return jsonRpcError(id, JSONRPC_INVALID_REQUEST, "Invalid Request: method must be a string");
  }
  const p = (params && typeof params === "object" ? params : {}) as Json;
  try {
    switch (method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "prgenie", version: "0.1.2" },
        });
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: RUNNER_MCP_TOOLS });
      case "tools/call": {
        const name = String(p.name ?? "");
        if (!isRunnerTool(name)) {
          return jsonRpcError(id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name}`);
        }
        const toolArgs = (
          p.arguments && typeof p.arguments === "object" ? p.arguments : {}
        ) as Json;
        try {
          const structured = await handleRunnerTool(engine, name, toolArgs);
          return jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          });
        } catch (err) {
          return jsonRpcError(id, JSONRPC_TOOL_ERROR, errorMessage(err));
        }
      }
      default:
        return jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, errorMessage(err));
  }
}
