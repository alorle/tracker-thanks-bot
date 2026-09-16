import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";
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
