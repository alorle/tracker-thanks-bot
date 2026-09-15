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
