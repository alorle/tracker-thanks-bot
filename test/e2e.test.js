import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker } from "./fake-tracker.js";
import { startFakeQBittorrent } from "./fake-qbittorrent.js";

// Business scenario:
//   The Operator configures a Site "fake-site" in sites.json and sets
//   credentials in env. Radarr grabs a torrent whose qBittorrent comment
//   points at that Site. The bot must identify the Site from the comment,
//   resolve credentials from the id, log into the tracker, and click the
//   thanks button on the right torrent page.
test("operator config drives the full grab → thanks flow", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
  });

  const torrentHash = "abcdef1234567890abcdef1234567890abcdef12";
  const trackerTorrentId = "9876";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([
      [torrentHash, {
        name: "Some.Movie.2024",
        comment: `Auto-uploaded by client. Source: ${tracker.baseUrl}/torrents/${trackerTorrentId} — enjoy!`,
      }],
    ]),
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-e2e-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(sitesPath, JSON.stringify({
    sites: [{ id: "fake-site", base_url: tracker.baseUrl }],
  }));

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.CACHE_DIR = join(tmpDir, "cache");
  process.env.FAKE_SITE_USERNAME = "operator-user";
  process.env.FAKE_SITE_PASSWORD = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;

  const { loadSites, getSiteCredentials } = await import("../dist/config.js");
  const { parseTorrentComment } = await import("../dist/url-parser.js");
  const { QBittorrentClient } = await import("../dist/qbittorrent.js");
  const { getPage, enqueue, closeAll } = await import("../dist/browser.js");
  const { thankTorrent } = await import("../dist/thanks.js");

  t.after(async () => {
    await closeAll();
    await tracker.close();
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  await t.test("loads the operator-supplied Site from sites.json", () => {
    const sites = loadSites();
    assert.equal(sites.size, 1);
    const site = sites.get("fake-site");
    assert.ok(site, "expected site keyed by configured id");
    assert.equal(site.id, "fake-site");
    assert.equal(site.baseUrl, tracker.baseUrl);
    assert.equal(site.loginButtonSelector, 'button[type="submit"]');
  });

  await t.test("identifies the Site from a qBittorrent comment", async () => {
    const sites = loadSites();
    const qbClient = QBittorrentClient.fromEnv();
    const comment = await qbClient.getTorrentComment(torrentHash);
    assert.match(comment, /\/torrents\/9876/);

    const parsed = parseTorrentComment(sites, comment);
    assert.ok(parsed, "expected parser to match the configured base_url");
    assert.equal(parsed.siteKey, "fake-site");
    assert.equal(parsed.torrentId, trackerTorrentId);
  });

  await t.test("derives credentials from the Site id", () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    const credentials = getSiteCredentials(site);
    assert.equal(credentials.username, "operator-user");
    assert.equal(credentials.password, "operator-pw");
  });

  await t.test("logs into the tracker and clicks the thanks button", async () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    const { username, password } = getSiteCredentials(site);

    await enqueue("fake-site", async () => {
      const page = await getPage("fake-site");
      await thankTorrent(page, trackerTorrentId, username, password, site, "e2e");
    });

    assert.equal(tracker.logins.length, 1, "tracker should have observed one login");
    assert.deepEqual(tracker.logins[0], { username: "operator-user", ok: true });

    assert.equal(tracker.clicks.length, 1, "tracker should have observed exactly one thanks click");
    assert.equal(tracker.clicks[0].torrentId, trackerTorrentId);
    assert.equal(tracker.clicks[0].authed, true, "click must be made with an authenticated session");
  });

  await t.test("reuses the persistent session and does not re-login", async () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    const { username, password } = getSiteCredentials(site);

    // Add a second torrent on the same Site to confirm session reuse.
    const secondTorrentId = "12345";
    await enqueue("fake-site", async () => {
      const page = await getPage("fake-site");
      await thankTorrent(page, secondTorrentId, username, password, site, "e2e");
    });

    assert.equal(tracker.logins.length, 1, "second thank should reuse the cached session");
    assert.equal(tracker.clicks.length, 2);
    assert.equal(tracker.clicks[1].torrentId, secondTorrentId);
    assert.equal(tracker.clicks[1].authed, true);
  });
});
