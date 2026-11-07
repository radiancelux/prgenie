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
import { loadSettings, saveSettings, toPublicSettings, type SettingsPatch } from "./settings.js";
import { runnerUiHtml } from "./ui-html.js";
import { setupUiHtml } from "./setup-ui-html.js";

const TERMINAL_JOB_STAGES = new Set([
  "approved",
  "failed",
  "stopped",
  "changes_remaining",
  "stuck",
]);

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function checkAuth(req: http.IncomingMessage, config: RunnerConfig, url: URL): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${config.token}`) return true;
  const q = url.searchParams.get("token");
  return q === config.token;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (tooLarge) return;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Write a JSON error without ever writing a second response. */
function respondError(res: http.ServerResponse, status: number, code: string): void {
  try {
    if (res.destroyed) return;
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: code }));
  } catch {
    // Socket went away between the checks and the write; nothing left to send.
  }
}

/** Last-resort boundary for the whole request path: log diagnostics, never leak input. */
function handleRequestFailure(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  err: unknown,
): void {
  if (err instanceof BodyTooLargeError) {
    respondError(res, 413, "payload_too_large");
    return;
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[runner] ${req.method ?? "unknown"} request failed: ${detail}`);
  respondError(res, 500, "internal_error");
}

/** Parse a JSON object body, rejecting malformed JSON and non-object payload shapes. */
function parseJsonObject(body: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function startHttpServer(config: RunnerConfig, engine: RunnerEngine): http.Server {
  const sseClients = new Map<string, Set<http.ServerResponse>>();

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
      res.write(`data: ${payload}\n\n`);
    }
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${urlHostForRequest(config.host)}:${config.port}`);
    } catch {
      respondError(res, 400, "invalid_request");
      return;
    }
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(runnerUiHtml(config.port, runnerListenUrls(config.host, config.port)));
      return;
    }

    if (path === "/setup" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(setupUiHtml(config.port, runnerListenUrls(config.host, config.port)));
      return;
    }

    const needsAuth = path.startsWith("/api/") || path === "/mcp";
    if (needsAuth && !checkAuth(req, config, url)) {
      unauthorized(res);
      return;
    }

    if (path === "/mcp" && req.method === "POST") {
      const body = await readBody(req);
      const msg = parseJsonObject(body) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      } | null;
      if (!msg) {
        respondError(res, 400, "invalid_request");
        return;
      }
      const reply = await handleMcpJsonRpc(engine, msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(reply ? JSON.stringify(reply) : "{}");
      return;
    }

    if (path === "/api/jobs/meta" && req.method === "GET") {
      const meta = await engine.jobsMeta();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meta));
      return;
    }

    if (path === "/api/jobs" && req.method === "GET") {
      const includeFinished =
        url.searchParams.get("includeFinished") === "1" ||
        url.searchParams.get("includeFinished") === "true";
      const jobs = await engine.list({ includeFinished });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jobs));
      return;
    }

    if (path === "/api/jobs" && req.method === "POST") {
      const body = await readBody(req);
      const payload = parseJsonObject(body);
      if (!payload) {
        respondError(res, 400, "invalid_payload");
        return;
      }
      try {
        const job = await engine.startJob({
          repoPath: typeof payload.repoPath === "string" ? payload.repoPath : undefined,
          remote: typeof payload.remote === "string" ? payload.remote : undefined,
          branch: String(payload.branch ?? ""),
          promptFile: typeof payload.promptFile === "string" ? payload.promptFile : undefined,
          reviewPromptFile:
            typeof payload.reviewPromptFile === "string" ? payload.reviewPromptFile : undefined,
          fixPromptFile:
            typeof payload.fixPromptFile === "string" ? payload.fixPromptFile : undefined,
          maxRounds: typeof payload.maxRounds === "number" ? payload.maxRounds : undefined,
          model: typeof payload.model === "string" ? payload.model : undefined,
          driver: typeof payload.driver === "string" ? payload.driver : undefined,
          dryRun: typeof payload.dryRun === "boolean" ? payload.dryRun : undefined,
          ticketUrl: typeof payload.ticketUrl === "string" ? payload.ticketUrl : undefined,
          linearIssue: typeof payload.linearIssue === "string" ? payload.linearIssue : undefined,
          jobType:
            payload.jobType === "docs" || payload.jobType === "code" ? payload.jobType : undefined,
          profile:
            payload.profile === "docs" || payload.profile === "code" ? payload.profile : undefined,
          docsTemplate:
            payload.docsTemplate === "marketing" ||
            payload.docsTemplate === "policy" ||
            payload.docsTemplate === "research"
              ? payload.docsTemplate
              : undefined,
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(job));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (path === "/api/notify-settings" && req.method === "GET") {
      const settings = await loadNotifySettings(config.dataDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(toPublicNotifySettings(config, settings)));
      return;
    }

    if (path === "/api/notify-settings" && req.method === "PUT") {
      const body = await readBody(req);
      const payload = parseJsonObject(body) as { enabled?: unknown; recipient?: unknown } | null;
      if (!payload) {
        respondError(res, 400, "invalid_payload");
        return;
      }
      const patch: { enabled?: boolean; recipient?: string | null } = {};
      if (payload.enabled !== undefined) patch.enabled = Boolean(payload.enabled);
      if (payload.recipient !== undefined) {
        patch.recipient =
          payload.recipient === null || payload.recipient === ""
            ? null
            : String(payload.recipient).trim();
      }
      const saved = await saveNotifySettings(config.dataDir, patch);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(toPublicNotifySettings(config, saved)));
      return;
    }

    if (path === "/api/settings" && req.method === "GET") {
      const settings = await loadSettings(config.dataDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(toPublicSettings(config, settings)));
      return;
    }

    if (path === "/api/settings" && req.method === "PATCH") {
      const body = await readBody(req);
      const payload = parseJsonObject(body) as
        (SettingsPatch & { notify?: { enabled?: unknown; recipient?: unknown } }) | null;
      if (!payload) {
        respondError(res, 400, "invalid_payload");
        return;
      }
      const patch: SettingsPatch = {};
      if (payload.configured !== undefined) patch.configured = Boolean(payload.configured);
      if (payload.defaultModel !== undefined) {
        patch.defaultModel =
          payload.defaultModel === null || payload.defaultModel === ""
            ? null
            : String(payload.defaultModel).trim();
      }
      if (payload.defaultDriver !== undefined) {
        patch.defaultDriver = String(payload.defaultDriver ?? "").trim() || "cursor-agent";
      }
      if (payload.hostBindHint !== undefined) {
        patch.hostBindHint =
          payload.hostBindHint === null || payload.hostBindHint === ""
            ? null
            : String(payload.hostBindHint).trim();
      }
      if (payload.notify) {
        patch.notify = {};
        if (payload.notify.enabled !== undefined) {
          patch.notify.enabled = Boolean(payload.notify.enabled);
        }
        if (payload.notify.recipient !== undefined) {
          patch.notify.recipient =
            payload.notify.recipient === null || payload.notify.recipient === ""
              ? null
              : String(payload.notify.recipient).trim();
        }
      }
      if (Array.isArray(payload.drivers)) {
        patch.drivers = payload.drivers.map((d) => ({
          id: String(d.id ?? ""),
          kind: d.kind,
          binary: d.binary ?? null,
          endpoint: d.endpoint ?? null,
          notes: d.notes ?? null,
          apiKey:
            typeof d.apiKey === "string" && d.apiKey.trim() && !/^•+$/.test(d.apiKey.trim())
              ? d.apiKey.trim()
              : d.apiKey === null
                ? null
                : undefined,
        }));
      }
      if (payload.jobTypes !== undefined && typeof payload.jobTypes === "object") {
        patch.jobTypes = payload.jobTypes as Record<string, unknown>;
      }
      if (payload.presets !== undefined && typeof payload.presets === "object") {
        patch.presets = payload.presets as Record<string, unknown>;
      }
      const saved = await saveSettings(config.dataDir, patch);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(toPublicSettings(config, saved)));
      return;
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      const job = await engine.get(jobMatch[1]);
      if (!job) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(job));
      return;
    }

    const streamMatch = path.match(/^\/api\/jobs\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      const jobId = streamMatch[1];
      res.writeHead(200, {
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
      const body = await readBody(req);
      const payload = parseJsonObject(body) as { prompt?: unknown } | null;
      if (!payload) {
        respondError(res, 400, "invalid_payload");
        return;
      }
      const prompt = String(payload.prompt ?? "");
      const existing = await engine.get(steerMatch[1]);
      if (!existing) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (TERMINAL_JOB_STAGES.has(existing.stage)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "job is terminal", stage: existing.stage }));
        return;
      }
      const job = await engine.steer(steerMatch[1], prompt);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, stage: job.stage, steerQueueLength: job.steerQueue.length }),
      );
      return;
    }

    const stopMatch = path.match(/^\/api\/jobs\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      const job = await engine.stop(stopMatch[1]);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stage: job.stage }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => handleRequestFailure(req, res, err));
  });

  server.listen(config.port, config.host);
  return server;
}
