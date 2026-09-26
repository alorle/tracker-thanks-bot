import { test } from "node:test";
import assert from "node:assert/strict";
import { createTorrentThanks, type TorrentThanks } from "../src/torrent-thanks.ts";
import type { Site, SitesMap } from "../src/config.ts";
import type { ThankTarget, Thanks, ThanksOutcome } from "../src/thank.ts";

const site = (id: string, baseUrl: string): Site => ({
  id,
  baseUrl,
  username: "operator-user",
  password: "operator-pw",
});

const sites: SitesMap = new Map([
  ["alpha", site("alpha", "https://a.example.com")],
  ["beta", site("beta", "https://b.example.com")],
]);

type Recorded = { readOnce: string[]; waitedFor: string[]; thanked: ThankTarget[] };

function wire(
  comment: string,
  outcome: ThanksOutcome = { status: "thanked", detail: "clicked" },
): { thankTorrent: TorrentThanks; recorded: Recorded } {
  const recorded: Recorded = { readOnce: [], waitedFor: [], thanked: [] };

  const qbClient = {
    getTorrentComment: (hash: string) => {
      recorded.readOnce.push(hash);
      return Promise.resolve(comment);
    },
    getTorrentCommentWithRetry: (hash: string) => {
      recorded.waitedFor.push(hash);
      return Promise.resolve(comment);
    },
  };

  const thanks: Thanks = {
    thank: (target) => {
      recorded.thanked.push(target);
      return Promise.resolve(outcome);
    },
    drainAll: () => Promise.resolve(),
  };

  return { thankTorrent: createTorrentThanks(sites, qbClient, thanks), recorded };
}

void test("the torrent is thanked on the Site its comment names", async () => {
  const { thankTorrent, recorded } = wire("Grabbed from https://b.example.com/torrents/4321 — ok");

  const result = await thankTorrent("abc123");

  assert.equal(result.status, "thanked");
  assert.deepEqual(recorded.readOnce, ["abc123"]);
  assert.equal(recorded.thanked.length, 1);
  assert.equal(recorded.thanked[0]?.site.id, "beta");
  assert.equal(recorded.thanked[0]?.torrentId, "4321");
});

void test("a host that merely looks like the Site is not thanked", async () => {
  for (const comment of ["https://aXexample.com/torrents/1", "https://a-example.com/torrents/1"]) {
    const { thankTorrent, recorded } = wire(comment);
    const result = await thankTorrent("abc123");
    assert.equal(result.status, "no_site", `expected no Site for "${comment}"`);
    assert.deepEqual(recorded.thanked, [], "a look-alike host must reach no Site");
  }
});

void test("a Site URL carrying no torrent id matches no Site", async () => {
  for (const comment of ["https://a.example.com/torrents/", "https://a.example.com/torrents/abc"]) {
    const { thankTorrent } = wire(comment);
    assert.equal((await thankTorrent("abc123")).status, "no_site");
  }
});

void test("a comment naming no configured Site comes back with the comment that was read", async () => {
  const { thankTorrent, recorded } = wire("https://other.example.com/torrents/7");

  const result = await thankTorrent("abc123");

  assert.equal(result.status, "no_site");
  assert.equal(
    result.status === "no_site" ? result.comment : null,
    "https://other.example.com/torrents/7",
    "the caller logs the comment it failed to match, so the result must carry it",
  );
  assert.deepEqual(recorded.thanked, []);
});

void test("a torrent whose comment qBittorrent has not filled in yet thanks nothing", async () => {
  const { thankTorrent, recorded } = wire("");

  const result = await thankTorrent("abc123");

  assert.equal(
    result.status,
    "no_comment",
    "an empty comment is not a Site that failed to match, and the caller reports them apart",
  );
  assert.deepEqual(recorded.thanked, []);
});

void test("only a caller that asks for it waits for the comment to appear", async () => {
  const waiting = wire("https://a.example.com/torrents/1");
  await waiting.thankTorrent("abc123", { waitForComment: true });
  assert.deepEqual(waiting.recorded.waitedFor, ["abc123"], "the webhook must wait out the retries");
  assert.deepEqual(waiting.recorded.readOnce, [], "and must not settle for a single read");

  const impatient = wire("https://a.example.com/torrents/1");
  await impatient.thankTorrent("abc123");
  assert.deepEqual(impatient.recorded.readOnce, ["abc123"], "a scan must read the comment once");
  assert.deepEqual(impatient.recorded.waitedFor, [], "and must never wait out the retries");
});

void test("the verdict the Site gave comes back with the result", async () => {
  const { thankTorrent } = wire("https://a.example.com/torrents/1", {
    status: "skipped",
    reason: "already_thanked",
  });

  const result = await thankTorrent("abc123");

  assert.equal(result.status, "skipped");
  assert.deepEqual(
    result.status === "skipped" ? result.outcome : null,
    { status: "skipped", reason: "already_thanked" },
    "the scan tallies this verdict, so it must not be flattened into a success",
  );
});
