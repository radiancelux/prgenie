import http from "node:http";
import { URL } from "node:url";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { runnerListenUrls, urlHostForRequest } from "./listen-urls.js";
import {
  loadNotifySettings,
  saveNotifySettings,
  toPublicNotifySettings,
} from "./notify-settings.js";
import { readLogTail } from "./store.js";
import { runnerUiHtml } from "./ui-html.js";

const TERMINAL_JOB_STAGES = new Set([
  "approved",
  "failed",
  "stopped",
  "changes_remaining",
  "stuck",
]);

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
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${urlHostForRequest(config.host)}:${config.port}`);
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(runnerUiHtml(config.port, runnerListenUrls(config.host, config.port)));
      return;
    }

    const needsAuth = path.startsWith("/api/") || path === "/mcp";
    if (needsAuth && !checkAuth(req, config, url)) {
      unauthorized(res);
      return;
    }

    if (path === "/mcp" && req.method === "POST") {
      const body = await readBody(req);
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const reply = await handleMcpJsonRpc(engine, msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(reply ? JSON.stringify(reply) : "{}");
      return;
    }

    if (path === "/api/jobs" && req.method === "GET") {
      const jobs = await engine.list();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jobs));
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
      let payload: { enabled?: unknown; recipient?: unknown };
      try {
        payload = JSON.parse(body) as { enabled?: unknown; recipient?: unknown };
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
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
      let payload: { prompt?: unknown };
      try {
        payload = JSON.parse(body) as { prompt?: unknown };
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
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
  });

  server.listen(config.port, config.host);
  return server;
}
