import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeQBittorrent, type FakeTorrent } from "./fake-qbittorrent.ts";
import { startFakeTracker } from "./fake-tracker.ts";
import { metricValue } from "./metric-probe.ts";

async function startBot(
  t: TestContext,
  {
    siteId,
    baseUrl,
    torrents,
    secret,
  }: { siteId: string; baseUrl: string; torrents?: Map<string, FakeTorrent>; secret?: string },
): Promise<number> {
  const qbit = await startFakeQBittorrent({ torrents });

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-webhook-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(sitesPath, JSON.stringify({ sites: [{ id: siteId, base_url: baseUrl }] }));

  const { loadSites, envVarBase } = await import("../src/config.ts");
  const { QBittorrentClient } = await import("../src/qbittorrent.ts");
  const { startServer } = await import("../src/webhook-server.ts");

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.CACHE_DIR = join(tmpDir, "cache");
  process.env.THANKS_ENGINE = "http";
  process.env[`${envVarBase(siteId)}_USERNAME`] = "operator-user";
  process.env[`${envVarBase(siteId)}_PASSWORD`] = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;
  if (secret === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = secret;

  const server = await startServer(loadSites(), 0, QBittorrentClient.fromEnv());
  const address = server.address();

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  return typeof address === "object" && address ? address.port : 0;
}

// The Grab handler answers before it does the work, so the click lands after
// the response. Polling is what makes that observable without a fixed sleep.
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await sleep(10);
  }
}

// This is how the bot is actually triggered in production: Radarr posts a Grab,
// the bot looks the hash up in qBittorrent, matches the comment against a Site
// and thanks. Every other test wires those steps by hand, so without this one
// the whole webhook path could stop calling thank() unnoticed.
void test("a Grab webhook thanks the torrent it names", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
  });
  t.after(() => tracker.close());

  const torrentHash = "abcdef1234567890abcdef1234567890abcdef12";
  const port = await startBot(t, {
    siteId: "grab-site",
    baseUrl: tracker.baseUrl,
    torrents: new Map([
      [
        torrentHash,
        { name: "Some.Movie.2024", comment: `Source: ${tracker.baseUrl}/torrents/9876` },
      ],
    ]),
  });

  const before = await metricValue("tracker_webhooks_received_total", {
    source: "radarr",
    event_type: "Grab",
  });

  const response = await fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventType: "Grab",
      downloadId: torrentHash.toUpperCase(),
      movie: { title: "Some.Movie.2024" },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await metricValue("tracker_webhooks_received_total", {
      source: "radarr",
      event_type: "Grab",
    })) - before,
    1,
    "the event must be counted against the endpoint it arrived on",
  );
  assert.deepEqual(await response.json(), {
    status: "accepted",
    hash: torrentHash.toUpperCase(),
  });

  await waitFor(() => tracker.clicks.length === 1, "the Grab must reach the Site as a thanks");
  assert.equal(tracker.clicks[0]?.torrentId, "9876");
  assert.equal(tracker.clicks[0]?.authed, true, "the thanks must carry a logged-in session");
});

// The webhook endpoints are anonymous when the Operator leaves WEBHOOK_SECRET
// unset, so an oversized body must be refused as it arrives rather than
// buffered whole.
void test("an oversized webhook body is cut off and leaves the server healthy", async (t) => {
  const port = await startBot(t, {
    siteId: "fake-site",
    baseUrl: "https://tracker.example.com",
  });

  await assert.rejects(
    () =>
      fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "Grab", padding: "x".repeat(512 * 1024) }),
      }),
    // A transport failure, not an HTTP status: the socket must die mid-body.
    // The errno itself is left open, it differs between macOS and CI.
    (err: unknown) =>
      err instanceof TypeError && err.message === "fetch failed" && err.cause !== undefined,
    "the connection must be cut instead of buffering the whole body",
  );

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "the server must still serve other requests");

  const small = await fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType: "Download" }),
  });
  assert.equal(small.status, 200, "a normal payload must still be accepted");
});

// WEBHOOK_SECRET is the bot's only authentication, and timingSafeEqual throws
// on operands of different lengths, so the length check in front of it is load
// bearing: a secret of the wrong size must be rejected, not crash the handler.
void test("a Grab is refused unless it carries the configured secret", async (t) => {
  const port = await startBot(t, {
    siteId: "secret-site",
    baseUrl: "https://tracker.example.com",
    secret: "s3cr3t-value",
  });

  const post = (headers: Record<string, string>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ eventType: "Download" }),
    });

  const refused: [string, Record<string, string>][] = [
    ["no secret at all", {}],
    ["a wrong secret of the same length", { "x-webhook-secret": "wr0ng-value!" }],
    ["a secret of a different length", { "x-webhook-secret": "short" }],
  ];
  for (const [what, headers] of refused) {
    const response = await post(headers);
    assert.equal(response.status, 401, `expected ${what} to be rejected`);
  }

  const accepted = await post({ "x-webhook-secret": "s3cr3t-value" });
  assert.equal(accepted.status, 200, "the configured secret must be accepted");
});

// Sonarr posts to its own endpoint and carries the hash one level down, inside
// `release`. Reading only the top-level downloadId turns every Sonarr grab into
// a 400, which is exactly half the bot's traffic.
void test("a Sonarr Grab naming the hash inside release is thanked", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
  });
  t.after(() => tracker.close());

  const torrentHash = "abcdef1234567890abcdef1234567890abcdef12";
  const port = await startBot(t, {
    siteId: "sonarr-site",
    baseUrl: tracker.baseUrl,
    torrents: new Map([
      [torrentHash, { name: "Some.Show.S01E01", comment: `${tracker.baseUrl}/torrents/9876` }],
    ]),
  });

  const before = await metricValue("tracker_webhooks_received_total", {
    source: "sonarr",
    event_type: "Grab",
  });

  const logged = t.mock.method(console, "log");

  const response = await fetch(`http://127.0.0.1:${port}/webhook/sonarr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventType: "Grab",
      release: { downloadId: torrentHash },
      series: { title: "Some.Show" },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "accepted", hash: torrentHash });

  await waitFor(() => tracker.clicks.length === 1, "the Sonarr grab must reach the Site");
  assert.equal(tracker.clicks[0]?.torrentId, "9876");

  const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    lines.some((line) => line.includes('Grab event for "Some.Show"')),
    "the log must name the series, not report it as unknown",
  );

  const after = await metricValue("tracker_webhooks_received_total", {
    source: "sonarr",
    event_type: "Grab",
  });
  assert.equal(after - before, 1, "the event must be counted against the endpoint it arrived on");
});

// /metrics is the whole reason prom-client is a dependency; nothing else in the
// bot reads the registry back out.
void test("GET /metrics serves the registry in Prometheus format", async (t) => {
  const port = await startBot(t, {
    siteId: "metrics-site",
    baseUrl: "https://tracker.example.com",
  });

  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(body, /tracker_webhooks_received_total/, "the bot's own metrics must be exposed");
  assert.match(body, /app="tracker-thanks-bot"/, "the registry's default label must be applied");
});

void test("an unknown route is a 404", async (t) => {
  const port = await startBot(t, {
    siteId: "notfound-site",
    baseUrl: "https://tracker.example.com",
  });

  const response = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
});

// The cap refuses what is past it, not what reaches it: a payload of exactly
// the maximum is a legitimate one and must be answered, not cut off.
void test("a body of exactly the maximum size is still served", async (t) => {
  const port = await startBot(t, { siteId: "limit-site", baseUrl: "https://tracker.example.com" });

  const maxBytes = 256 * 1024;
  const envelope = JSON.stringify({ eventType: "Download", padding: "" });
  const body = JSON.stringify({
    eventType: "Download",
    padding: "x".repeat(maxBytes - envelope.length),
  });
  assert.equal(Buffer.byteLength(body), maxBytes, "the test payload must sit exactly on the limit");

  const response = await fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
});
