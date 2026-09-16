import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTorrentComment } from "../src/url-parser.ts";
import type { SitesMap } from "../src/config.ts";

const sites: SitesMap = new Map([
  [
    "alpha",
    { id: "alpha", baseUrl: "https://a.example.com", loginButtonSelector: 'button[type="submit"]' },
  ],
  [
    "beta",
    { id: "beta", baseUrl: "https://b.example.com", loginButtonSelector: 'button[type="submit"]' },
  ],
]);

void test("the torrent id is taken from the Site the comment names", () => {
  const parsed = parseTorrentComment(
    sites,
    "Grabbed from https://b.example.com/torrents/4321 — enjoy",
  );
  assert.equal(parsed?.site.id, "beta");
  assert.equal(parsed?.torrentId, "4321");
});

// base_url goes into a regular expression, so its punctuation has to be escaped
// first: an unescaped dot matches any character, and every Site would then
// answer for a look-alike host.
void test("a host that merely looks like the Site does not match it", () => {
  assert.equal(parseTorrentComment(sites, "https://aXexample.com/torrents/1"), null);
  assert.equal(parseTorrentComment(sites, "https://a-example.com/torrents/1"), null);
});

void test("a Site URL carrying no torrent id does not match", () => {
  assert.equal(parseTorrentComment(sites, "https://a.example.com/torrents/"), null);
  assert.equal(parseTorrentComment(sites, "https://a.example.com/torrents/abc"), null);
});

void test("a comment naming no configured Site matches nothing", () => {
  assert.equal(parseTorrentComment(sites, "https://other.example.com/torrents/7"), null);
});
