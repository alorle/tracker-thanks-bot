import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { log } from "./log.ts";
import { getSiteCredentials, type SitesMap } from "./config.ts";
import { QBittorrentClient } from "./qbittorrent.ts";
import { parseTorrentComment } from "./url-parser.ts";
import { freshPage, enqueue, drainAll, closeAll } from "./browser.ts";
import { thankTorrent } from "./thanks.ts";
import { registry, webhooksReceived, webhookProcessingDuration } from "./metrics.ts";

const PREFIX = "webhook";
const SHUTDOWN_TIMEOUT_MS = 30_000;

// Radarr/Sonarr webhook payload (only fields we use)
type WebhookPayload = {
  eventType?: string;
  downloadId?: string;
  release?: {
    downloadId?: string;
  };
  movie?: { title?: string };
  series?: { title?: string };
};

function extractHash(payload: WebhookPayload): string | null {
  return payload.downloadId ?? payload.release?.downloadId ?? null;
}

function extractTitle(payload: WebhookPayload): string {
  return payload.movie?.title ?? payload.series?.title ?? "unknown";
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function checkSecret(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) return true;
  const got = req.headers["x-webhook-secret"];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  source: string,
  qbClient: QBittorrentClient,
  sites: SitesMap,
): Promise<void> {
  let payload: WebhookPayload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body) as WebhookPayload;
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON body." });
    return;
  }

  webhooksReceived.inc({ source, event_type: payload.eventType ?? "unknown" });

  if (payload.eventType !== "Grab") {
    log(PREFIX, `[${source}] Ignoring event: ${payload.eventType ?? "unknown"}`);
    jsonResponse(res, 200, {
      status: "ignored",
      reason: `Event type "${payload.eventType}" is not "Grab".`,
    });
    return;
  }

  const hash = extractHash(payload);
  if (!hash) {
    jsonResponse(res, 400, { error: "No downloadId found in payload." });
    return;
  }

  const title = extractTitle(payload);
  log(PREFIX, `[${source}] Grab event for "${title}" (hash: ${hash})`);

  // Respond immediately — processing happens async
  jsonResponse(res, 200, { status: "accepted", hash });

  // Process in the background
  processGrab(source, hash, title, qbClient, sites).catch((err) => {
    log(PREFIX, `[${source}] Error processing grab for "${title}": ${err}`);
  });
}

async function processGrab(
  source: string,
  hash: string,
  title: string,
  qbClient: QBittorrentClient,
  sites: SitesMap,
): Promise<void> {
  const stopTimer = webhookProcessingDuration.startTimer({ source });

  log(PREFIX, `[${source}] Querying qBittorrent for torrent comment (hash: ${hash})...`);
  const comment = await qbClient.getTorrentCommentWithRetry(hash);

  const parsed = parseTorrentComment(sites, comment);
  if (!parsed) {
    log(PREFIX, `[${source}] No matching site URL in comment: "${comment}". Skipping.`);
    stopTimer({ site: "unknown" });
    return;
  }

  const site = sites.get(parsed.siteKey);
  if (!site) {
    log(PREFIX, `[${source}] Unknown site key "${parsed.siteKey}". Skipping.`);
    stopTimer({ site: "unknown" });
    return;
  }

  log(PREFIX, `[${source}] Matched ${site.id} torrent ${parsed.torrentId} for "${title}".`);

  let credentials: { username: string; password: string };
  try {
    credentials = getSiteCredentials(site);
  } catch (err) {
    log(PREFIX, `[${source}] Missing credentials for ${site.id}: ${String(err)}`);
    stopTimer({ site: parsed.siteKey });
    return;
  }

  const logPrefix = `auto-thanks:${site.id}`;
  await enqueue(parsed.siteKey, async () => {
    const page = await freshPage(parsed.siteKey);
    await thankTorrent(
      page,
      parsed.torrentId,
      credentials.username,
      credentials.password,
      site,
      logPrefix,
    );
  });

  stopTimer({ site: parsed.siteKey });
  log(PREFIX, `[${source}] Done processing "${title}".`);
}

async function gracefulShutdown(signal: string, server: Server): Promise<void> {
  log(PREFIX, `${signal} received, draining (timeout ${SHUTDOWN_TIMEOUT_MS / 1000}s)...`);

  const forceExit = setTimeout(() => {
    log(PREFIX, "Shutdown timeout exceeded, forcing exit.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log(PREFIX, "HTTP server closed. Draining in-flight thank tasks...");
    await drainAll();
    log(PREFIX, "Tasks drained. Closing browser contexts...");
    await closeAll();
    log(PREFIX, "Shutdown complete.");
    process.exit(0);
  } catch (err) {
    log(PREFIX, `Error during shutdown: ${String(err)}`);
    process.exit(1);
  }
}

export async function startServer(sites: SitesMap, port: number): Promise<void> {
  const qbClient = QBittorrentClient.fromEnv();
  const webhookSecret = process.env.WEBHOOK_SECRET ?? null;
  if (!webhookSecret) {
    log(PREFIX, "WARNING: WEBHOOK_SECRET not set — /webhook/* endpoints are unauthenticated.");
  }

  let shuttingDown = false;

  const server = createServer((req, res) => {
    if (shuttingDown) {
      jsonResponse(res, 503, { error: "Server shutting down." });
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      registry
        .metrics()
        .then((metrics) => {
          res.writeHead(200, { "Content-Type": registry.contentType });
          res.end(metrics);
        })
        .catch((err) => {
          log(PREFIX, `Error generating metrics: ${err}`);
          jsonResponse(res, 500, { error: "Failed to generate metrics." });
        });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, { status: "healthy" });
      return;
    }
    if (req.method === "POST" && (req.url === "/webhook/radarr" || req.url === "/webhook/sonarr")) {
      if (!checkSecret(req, webhookSecret)) {
        log(PREFIX, `Rejected unauthenticated ${req.url} from ${req.socket.remoteAddress ?? "?"}`);
        jsonResponse(res, 401, { error: "Unauthorized." });
        return;
      }
      const source = req.url === "/webhook/radarr" ? "radarr" : "sonarr";
      handleWebhook(req, res, source, qbClient, sites).catch((err) => {
        log(PREFIX, `Unhandled error in ${source} handler: ${err}`);
        if (!res.headersSent) jsonResponse(res, 500, { error: "Internal server error." });
      });
      return;
    }
    jsonResponse(res, 404, { error: "Not found." });
  });

  const onSignal = (signal: string) => {
    if (shuttingDown) {
      log(PREFIX, `${signal} received again, forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    void gracefulShutdown(signal, server);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      log(PREFIX, `Listening on port ${port}`);
      log(
        PREFIX,
        "Endpoints: POST /webhook/radarr, POST /webhook/sonarr, GET /health, GET /metrics",
      );
      resolve();
    });
  });
}
