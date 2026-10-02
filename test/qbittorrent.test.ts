import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";
import { histogramCount, metricValue } from "./metric-probe.ts";
import { QBittorrentClient } from "../src/qbittorrent.ts";

// A 403 used to re-authenticate and then call itself again, with no bound: a
// qBittorrent that keeps rejecting an otherwise valid session (an IP ban, say)
// kept the bot spinning until the stack blew instead of surfacing the error.
void test("a 403 that survives re-authentication is reported, not retried forever", async (t) => {
  const qbit = await startFakeQBittorrent({ forbidden: "always" });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password: "qbit-pw" },
  });

  await assert.rejects(
    () => client.listTorrents(),
    /403/,
    "the persistent rejection must reach the caller",
  );

  const listCalls = qbit.requests.filter((path) => path === "/api/v2/torrents/info");
  assert.equal(listCalls.length, 2, "expected the original call plus exactly one retry");
});

// The retry is not only a bound, it is a recovery: qBittorrent drops sessions
// on its own schedule, and the bot must log in again and finish the call
// instead of surfacing a 403 the Operator never caused.
void test("a 403 on an expired session is recovered by re-authenticating", async (t) => {
  const qbit = await startFakeQBittorrent({
    forbidden: "once",
    torrents: new Map([["aaaa", { name: "Some.Movie.2024", comment: "irrelevant" }]]),
  });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password: "qbit-pw" },
  });

  assert.deepEqual(await client.listTorrents(), [{ hash: "aaaa", name: "Some.Movie.2024" }]);
  assert.deepEqual(
    qbit.requests,
    ["/api/v2/auth/login", "/api/v2/torrents/info", "/api/v2/auth/login", "/api/v2/torrents/info"],
    "the 403 must cost exactly one re-login and one retry",
  );
});

// Radarr reports the hash uppercase and qBittorrent's API only answers to the
// lowercase form, so the grab would look like a torrent that does not exist.
void test("the uppercase hash a Grab carries still finds the torrent", async (t) => {
  const hash = "abcdef1234567890abcdef1234567890abcdef12";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([[hash, { name: "Some.Movie.2024", comment: "the comment" }]]),
  });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password: "qbit-pw" },
  });

  assert.equal(await client.getTorrentComment(hash.toUpperCase()), "the comment");
});

// The API key path (qBittorrent 5.2+) is the preferred deployment and shares no
// code with the cookie login it replaces.
void test("an API key authenticates every call without ever logging in", async (t) => {
  const qbit = await startFakeQBittorrent({
    apiKey: "operator-api-key",
    torrents: new Map([["aaaa", { name: "Some.Movie.2024", comment: "irrelevant" }]]),
  });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "apikey", apiKey: "operator-api-key" },
  });

  assert.deepEqual(await client.listTorrents(), [{ hash: "aaaa", name: "Some.Movie.2024" }]);
  assert.deepEqual(
    qbit.requests,
    ["/api/v2/torrents/info"],
    "an API key needs no login round trip",
  );
});

void test("an API key qBittorrent rejects is reported, not retried as a session", async (t) => {
  const qbit = await startFakeQBittorrent({ apiKey: "the-right-key" });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "apikey", apiKey: "the-wrong-key" },
  });

  await assert.rejects(() => client.listTorrents(), /API key rejected/);
  assert.equal(
    qbit.requests.filter((path) => path === "/api/v2/auth/login").length,
    0,
    "a rejected key must not fall back to a username and password login",
  );
});

// This is the ordinary case, not an edge one: Radarr posts the Grab as soon as
// it sends the torrent, and qBittorrent only publishes the comment once it has
// the metadata, so the first read comes back empty.
void test("a comment that is not there yet is waited for, with a growing delay", async (t) => {
  const hash = "aaaa";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([[hash, { name: "Some.Movie.2024", comment: "the comment" }]]),
    emptyCommentAttempts: 2,
  });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password: "qbit-pw" },
  });

  const startedAt = Date.now();
  assert.equal(
    await client.getTorrentCommentWithRetry(hash, { initialDelayMs: 50 }),
    "the comment",
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(
    qbit.requests.filter((path) => path === "/api/v2/torrents/properties").length,
    3,
    "two empty reads and the one that carried the comment",
  );
  // 50ms then 100ms: each wait doubles, and the first is not already doubled.
  assert.ok(elapsed >= 140, `expected the backoff to be waited out, took ${elapsed}ms`);
  assert.ok(elapsed < 280, `expected 50ms + 100ms of backoff, took ${elapsed}ms`);
});

void test("a comment that never arrives gives up after the full round of attempts", async (t) => {
  const hash = "aaaa";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([[hash, { name: "Some.Movie.2024", comment: "never served" }]]),
    emptyCommentAttempts: 99,
  });
  t.after(() => qbit.close());

  const client = new QBittorrentClient({
    baseUrl: qbit.baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password: "qbit-pw" },
  });

  await assert.rejects(
    () => client.getTorrentCommentWithRetry(hash, { initialDelayMs: 10 }),
    /still empty after 5 attempts/,
  );
  assert.equal(
    qbit.requests.filter((path) => path === "/api/v2/torrents/properties").length,
    5,
    "the default is five attempts, and every one of them must be spent",
  );
});

const cookieClient = (baseUrl: string, password = "qbit-pw"): QBittorrentClient =>
  new QBittorrentClient({
    baseUrl,
    credentials: { mode: "cookie", username: "qbit-user", password },
  });

void test("a login qBittorrent turns down is reported with its answer", async (t) => {
  const qbit = await startFakeQBittorrent();
  t.after(() => qbit.close());

  await assert.rejects(
    () => cookieClient(qbit.baseUrl, "wrong-pw").listTorrents(),
    /qBittorrent login failed: Fails\. \(check credentials or IP ban\)/,
  );
  assert.equal(
    qbit.requests.filter((path) => path === "/api/v2/torrents/info").length,
    0,
    "no data call may go out without a session",
  );
});

void test("a login refused with an HTTP error is reported with its status", async (t) => {
  const qbit = await startFakeQBittorrent({ loginStatus: 403 });
  t.after(() => qbit.close());

  await assert.rejects(
    () => cookieClient(qbit.baseUrl).listTorrents(),
    /qBittorrent login failed: HTTP 403 Forbidden/,
  );
});

void test("a login that hands out no session is reported", async (t) => {
  const qbit = await startFakeQBittorrent({ withoutSid: true });
  t.after(() => qbit.close());

  await assert.rejects(
    () => cookieClient(qbit.baseUrl).listTorrents(),
    /qBittorrent login failed: no SID cookie received\./,
  );
});

void test("one login serves every call that follows", async (t) => {
  const qbit = await startFakeQBittorrent();
  t.after(() => qbit.close());

  const client = cookieClient(qbit.baseUrl);
  await client.listTorrents();
  await client.listTorrents();

  assert.deepEqual(qbit.requests, [
    "/api/v2/auth/login",
    "/api/v2/torrents/info",
    "/api/v2/torrents/info",
  ]);
});

void test("every API call is timed and a failed one is counted, both by endpoint", async (t) => {
  const hash = "aaaa";
  const healthy = await startFakeQBittorrent({
    torrents: new Map([[hash, { name: "Some.Movie.2024", comment: "the comment" }]]),
  });
  const failing = await startFakeQBittorrent({ forbidden: "always" });
  t.after(async () => {
    await healthy.close();
    await failing.close();
  });

  const timed = (endpoint: string) =>
    histogramCount("tracker_qbittorrent_api_duration_seconds", { endpoint });
  const failed = (endpoint: string) =>
    metricValue("tracker_qbittorrent_api_errors_total", { endpoint });
  const before = {
    info: await timed("torrents/info"),
    properties: await timed("torrents/properties"),
    errors: await failed("torrents/info"),
  };

  await cookieClient(healthy.baseUrl).getTorrentComment(hash);
  await assert.rejects(() => cookieClient(failing.baseUrl).listTorrents(), /403/);

  assert.equal((await timed("torrents/properties")) - before.properties, 1);
  assert.equal((await timed("torrents/info")) - before.info, 1, "a failed call is timed too");
  assert.equal((await failed("torrents/info")) - before.errors, 1);
});

void test("a comment that cannot be read is retried and the last error reported", async (t) => {
  const qbit = await startFakeQBittorrent();
  t.after(() => qbit.close());

  await assert.rejects(
    () =>
      cookieClient(qbit.baseUrl).getTorrentCommentWithRetry("missing", {
        maxAttempts: 3,
        initialDelayMs: 10,
      }),
    /qBittorrent API error: 404/,
  );
  assert.equal(qbit.requests.filter((path) => path === "/api/v2/torrents/properties").length, 3);
});

void test("giving up on a comment does not wait out one more delay first", async (t) => {
  const hash = "aaaa";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([[hash, { name: "Some.Movie.2024", comment: "never served" }]]),
    emptyCommentAttempts: 99,
  });
  t.after(() => qbit.close());

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      cookieClient(qbit.baseUrl).getTorrentCommentWithRetry(hash, {
        maxAttempts: 2,
        initialDelayMs: 100,
      }),
    /still empty after 2 attempts/,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 250,
    `expected a single 100ms wait between the two attempts, took ${elapsed}ms`,
  );
});
