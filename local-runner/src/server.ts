import http from "node:http";
import { URL } from "node:url";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { runnerListenUrls, urlHostForRequest } from "./listen-urls.js";
import { readLogTail } from "./store.js";
import {
  loadNotifySettings,
  saveNotifySettings,
  toPublicNotifySettings,
} from "./notify-settings.js";
import { loadSettings, saveSettings, SettingsConflictError, toPublicSettings } from "./settings.js";
import {
  normalizeStartJobArgs,
  parseSettingsPatch,
  ValidationError,
} from "./settings-validation.js";
import { runnerUiHtml } from "./ui-html.js";
import { setupUiHtml } from "./setup-ui-html.js";
import {
  HttpResponseGuard,
  parseJsonBody,
  parseJsonObject,
  readBoundedBody,
  safeHandlerMessage,
} from "./http-request.js";

const TERMINAL_JOB_STAGES = new Set([
  "approved",
  "failed",
  "stopped",
  "changes_remaining",
  "stuck",
]);

const ARCHIVE_ERROR_STATUS = {
  invalid_id: 400,
  not_found: 404,
  running: 409,
  collision: 409,
} as const;

/** Validation is 400, an optimistic-concurrency miss is 409, anything else is a server fault. */
function errorStatus(err: unknown): number {
  if (err instanceof ValidationError) return 400;
  if (err instanceof SettingsConflictError) return 409;
  return 500;
}

/** POST /api/jobs: same normalizer as MCP start_job, so both reject bad input identically. */
export async function handleStartJobRequest(
  engine: RunnerEngine,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 201, body: await engine.startJob(normalizeStartJobArgs(payload)) };
  } catch (err) {
    return { status: 400, body: { error: safeHandlerMessage(err) } };
  }
}

function queryFlag(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v === "1" || v === "true";
}

function unauthorized(guard: HttpResponseGuard): void {
  guard.json(401, { error: "unauthorized" });
}

function checkAuth(req: http.IncomingMessage, config: RunnerConfig, url: URL): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${config.token}`) return true;
  const q = url.searchParams.get("token");
  return q === config.token;
}

async function readJsonObject(
  req: http.IncomingMessage,
  guard: HttpResponseGuard,
): Promise<Record<string, unknown> | null> {
  const body = await readBoundedBody(req);
  if (!body.ok) {
    guard.json(body.status, { error: body.error });
    return null;
  }
  const parsed = parseJsonObject(body.text);
  if (!parsed.ok) {
    guard.json(400, { error: parsed.error });
    return null;
  }
  return parsed.value;
}

/** Like readJsonObject, but an empty body is `{}`. */
async function readOptionalJsonObject(
  req: http.IncomingMessage,
  guard: HttpResponseGuard,
): Promise<Record<string, unknown> | null> {
  const body = await readBoundedBody(req);
  if (!body.ok) {
    guard.json(body.status, { error: body.error });
    return null;
  }
  if (!body.text.trim()) return {};
  const parsed = parseJsonObject(body.text);
  if (!parsed.ok) {
    guard.json(400, { error: parsed.error });
    return null;
  }
  return parsed.value;
}

async function readMcpMessage(
  req: http.IncomingMessage,
  guard: HttpResponseGuard,
): Promise<{ id?: unknown; method?: string; params?: Record<string, unknown> } | null> {
  const body = await readBoundedBody(req);
  if (!body.ok) {
    guard.json(body.status, { error: body.error });
    return null;
  }
  const parsed = parseJsonBody(body.text);
  if (!parsed.ok) {
    guard.json(400, { error: parsed.error });
    return null;
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    guard.json(400, { error: "expected json object" });
    return null;
  }
  return value as { id?: unknown; method?: string; params?: Record<string, unknown> };
}

export function startHttpServer(config: RunnerConfig, engine: RunnerEngine): http.Server {
  const sseClients = new Map<string, Set<http.ServerResponse>>();
  const listClients = new Set<http.ServerResponse>();

  engine.on("jobs", () => {
    for (const res of listClients) {
      try {
        res.write(`data: ${JSON.stringify({ type: "jobs" })}\n\n`);
      } catch {
        /* client gone */
      }
    }
  });

  engine.on("event", async (jobId: string) => {
    const clients = sseClients.get(jobId);
    if (!clients?.size) return;
    const job = await engine.get(jobId);
    if (!job) return;
    const payload = JSON.stringify({
      stage: job.stage,
      reviewRound: job.reviewRound,
      logTail: job.logTail,
    });
    for (const res of clients) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        /* client gone */
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    const guard = new HttpResponseGuard(res);
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${urlHostForRequest(config.host)}:${config.port}`,
      );
      const path = url.pathname;

      if (path === "/" && req.method === "GET") {
        guard.html(200, runnerUiHtml(config.port, runnerListenUrls(config.host, config.port)));
        return;
      }

      if (path === "/setup" && req.method === "GET") {
        guard.html(200, setupUiHtml(config.port, runnerListenUrls(config.host, config.port)));
        return;
      }

      const needsAuth = path.startsWith("/api/") || path === "/mcp";
      if (needsAuth && !checkAuth(req, config, url)) {
        unauthorized(guard);
        return;
      }

      if (path === "/mcp" && req.method === "POST") {
        const msg = await readMcpMessage(req, guard);
        if (!msg || guard.started) return;
        const reply = await handleMcpJsonRpc(engine, msg);
        guard.json(200, reply ?? {});
        return;
      }

      if (path === "/api/jobs/meta" && req.method === "GET") {
        const meta = await engine.jobsMeta();
        guard.json(200, meta);
        return;
      }

      if (path === "/api/events" && req.method === "GET") {
        guard.begin({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        listClients.add(res);
        req.on("close", () => {
          listClients.delete(res);
        });
        res.write(": connected\n\n");
        return;
      }

      if (path === "/api/jobs" && req.method === "GET") {
        const jobs = await engine.list({
          includeFinished: queryFlag(url, "includeFinished"),
          includeArchived: queryFlag(url, "includeArchived"),
        });
        guard.json(200, jobs);
        return;
      }

      if (path === "/api/jobs/clear-failed" && req.method === "POST") {
        const payload = await readOptionalJsonObject(req, guard);
        if (!payload || guard.started) return;
        if (
          payload.includeStuckStopped !== undefined &&
          typeof payload.includeStuckStopped !== "boolean"
        ) {
          guard.json(400, { error: "includeStuckStopped must be a boolean" });
          return;
        }
        const result = await engine.clearFailed({
          includeStuckStopped: payload.includeStuckStopped === true,
        });
        guard.json(200, result);
        return;
      }

      if (path === "/api/jobs" && req.method === "POST") {
        const payload = await readJsonObject(req, guard);
        if (!payload || guard.started) return;
        const reply = await handleStartJobRequest(engine, payload);
        guard.json(reply.status, reply.body);
        return;
      }

      if (path === "/api/notify-settings" && req.method === "GET") {
        const settings = await loadNotifySettings(config.dataDir);
        guard.json(200, toPublicNotifySettings(config, settings));
        return;
      }

      if (path === "/api/notify-settings" && req.method === "PUT") {
        const payload = await readJsonObject(req, guard);
        if (!payload || guard.started) return;
        const patch: { enabled?: boolean; recipient?: string | null } = {};
        if (payload.enabled !== undefined) patch.enabled = Boolean(payload.enabled);
        if (payload.recipient !== undefined) {
          patch.recipient =
            payload.recipient === null || payload.recipient === ""
              ? null
              : String(payload.recipient).trim();
        }
        const saved = await saveNotifySettings(config.dataDir, patch);
        guard.json(200, toPublicNotifySettings(config, saved) as Record<string, unknown>);
        return;
      }

      if (path === "/api/settings" && req.method === "GET") {
        const settings = await loadSettings(config.dataDir);
        guard.json(200, toPublicSettings(config, settings));
        return;
      }

      if (path === "/api/settings" && req.method === "PATCH") {
        const payload = await readJsonObject(req, guard);
        if (!payload || guard.started) return;
        const patch = parseSettingsPatch(payload);
        const saved = await saveSettings(config.dataDir, patch);
        guard.json(200, toPublicSettings(config, saved) as Record<string, unknown>);
        return;
      }

      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === "GET") {
        const job = await engine.get(jobMatch[1]);
        if (!job) {
          guard.json(404, { error: "not found" });
          return;
        }
        guard.json(200, job);
        return;
      }

      const streamMatch = path.match(/^\/api\/jobs\/([^/]+)\/stream$/);
      if (streamMatch && req.method === "GET") {
        const jobId = streamMatch[1];
        guard.begin({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
        sseClients.get(jobId)!.add(res);
        req.on("close", () => {
          sseClients.get(jobId)?.delete(res);
        });
        const job = await engine.get(jobId);
        const tail = job?.logTail ?? (job ? await readLogTail(job.logPath) : "");
        res.write(`data: ${JSON.stringify({ logTail: tail, stage: job?.stage })}\n\n`);
        return;
      }

      const steerMatch = path.match(/^\/api\/jobs\/([^/]+)\/steer$/);
      if (steerMatch && req.method === "POST") {
        const payload = await readJsonObject(req, guard);
        if (!payload || guard.started) return;
        if (typeof payload.prompt !== "string" && payload.prompt !== undefined) {
          guard.json(400, { error: "prompt must be a string" });
          return;
        }
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const existing = await engine.get(steerMatch[1]);
        if (!existing) {
          guard.json(404, { error: "not found" });
          return;
        }
        if (TERMINAL_JOB_STAGES.has(existing.stage)) {
          guard.json(409, { error: "job is terminal", stage: existing.stage });
          return;
        }
        const job = await engine.steer(steerMatch[1], prompt);
        if (!job) {
          guard.json(404, { error: "not found" });
          return;
        }
        guard.json(200, {
          ok: true,
          stage: job.stage,
          steerQueueLength: job.steerQueue.length,
        });
        return;
      }

      const stopMatch = path.match(/^\/api\/jobs\/([^/]+)\/stop$/);
      if (stopMatch && req.method === "POST") {
        const job = await engine.stop(stopMatch[1]);
        if (!job) {
          guard.json(404, { error: "not found" });
          return;
        }
        guard.json(200, { ok: true, stage: job.stage });
        return;
      }

      const archiveMatch = path.match(/^\/api\/jobs\/([^/]+)\/archive$/);
      if (archiveMatch && req.method === "POST") {
        const result = await engine.archive(archiveMatch[1]);
        if (!result.ok) {
          guard.json(ARCHIVE_ERROR_STATUS[result.code], {
            error: result.error,
            ...(result.stage ? { stage: result.stage } : {}),
          });
          return;
        }
        guard.json(200, result);
        return;
      }

      const restoreMatch = path.match(/^\/api\/jobs\/([^/]+)\/restore$/);
      if (restoreMatch && req.method === "POST") {
        const result = await engine.restore(restoreMatch[1]);
        if (!result.ok) {
          guard.json(ARCHIVE_ERROR_STATUS[result.code], { error: result.error });
          return;
        }
        guard.json(200, { ok: true, id: result.id, stage: result.job.stage });
        return;
      }

      guard.text(404, "not found");
    } catch (err) {
      if (!guard.started) {
        guard.json(errorStatus(err), { error: safeHandlerMessage(err) });
      }
    }
  });

  server.listen(config.port, config.host);
  return server;
}
