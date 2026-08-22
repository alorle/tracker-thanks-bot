import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker } from "./fake-tracker.ts";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";

// Business scenario:
//   The Operator configures a Site "fake-site" in sites.json and sets
//   credentials in env. Radarr grabs a torrent whose qBittorrent comment
//   points at that Site. The bot must identify the Site from the comment,
//   resolve credentials from the id, log into the tracker, and click the
//   thanks button on the right torrent page.
void test("operator config drives the full grab → thanks flow", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
  });

  const torrentHash = "abcdef1234567890abcdef1234567890abcdef12";
  const trackerTorrentId = "9876";
  const qbit = await startFakeQBittorrent({
    torrents: new Map([
      [
        torrentHash,
        {
          name: "Some.Movie.2024",
          comment: `Auto-uploaded by client. Source: ${tracker.baseUrl}/torrents/${trackerTorrentId} — enjoy!`,
        },
      ],
    ]),
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-e2e-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(
    sitesPath,
    JSON.stringify({
      sites: [{ id: "fake-site", base_url: tracker.baseUrl }],
    }),
  );

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.CACHE_DIR = join(tmpDir, "cache");
  process.env.FAKE_SITE_USERNAME = "operator-user";
  process.env.FAKE_SITE_PASSWORD = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;

  const { loadSites, getSiteCredentials } = await import("../src/config.ts");
  const { parseTorrentComment } = await import("../src/url-parser.ts");
  const { QBittorrentClient } = await import("../src/qbittorrent.ts");
  const { freshPage, enqueue, closeAll } = await import("../src/browser.ts");
  const { thank } = await import("../src/thank.ts");

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
    assert.ok(site, "expected configured site");
    const credentials = getSiteCredentials(site);
    assert.equal(credentials.username, "operator-user");
    assert.equal(credentials.password, "operator-pw");
  });

  await t.test("logs into the tracker and clicks the thanks button", async () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");
    const { username, password } = getSiteCredentials(site);

    await thank("fake-site", trackerTorrentId, username, password, site, "e2e");

    assert.equal(tracker.logins.length, 1, "tracker should have observed one login");
    assert.deepEqual(tracker.logins[0], { username: "operator-user", ok: true });

    assert.equal(tracker.clicks.length, 1, "tracker should have observed exactly one thanks click");
    assert.equal(tracker.clicks[0]?.torrentId, trackerTorrentId);
    assert.equal(
      tracker.clicks[0]?.authed,
      true,
      "click must be made with an authenticated session",
    );
  });

  await t.test("reuses the persistent session and does not re-login", async () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");
    const { username, password } = getSiteCredentials(site);

    // Add a second torrent on the same Site to confirm session reuse.
    const secondTorrentId = "12345";
    await thank("fake-site", secondTorrentId, username, password, site, "e2e");

    assert.equal(tracker.logins.length, 1, "second thank should reuse the cached session");
    assert.equal(tracker.clicks.length, 2);
    assert.equal(tracker.clicks[1]?.torrentId, secondTorrentId);
    assert.equal(tracker.clicks[1]?.authed, true);
  });

  // Regression: a renderer killed mid-scan (the container's memory ceiling is
  // how it happens in production) used to poison every later torrent, because
  // the crashed page stayed cached and Playwright cannot revive one. Every
  // navigation after it failed with "Page crashed" until the process restarted.
  await t.test("a crashed page does not poison the next torrent", async () => {
    const sites = loadSites();
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");
    const { username, password } = getSiteCredentials(site);

    await enqueue("fake-site", async () => {
      const page = await freshPage("fake-site");
      // chrome://crash kills the renderer exactly like the OOM killer does.
      await page.goto("chrome://crash").catch(() => {});
    });

    const thirdTorrentId = "24680";
    await thank("fake-site", thirdTorrentId, username, password, site, "e2e");

    assert.equal(tracker.clicks.length, 3, "the torrent after a crash must still be thanked");
    assert.equal(tracker.clicks[2]?.torrentId, thirdTorrentId);
    assert.equal(
      tracker.clicks[2]?.authed,
      true,
      "the session must survive the crash: it lives in the context, not the page",
    );
    assert.equal(tracker.logins.length, 1, "recovering must not require a re-login");
  });
});

// The HTTP engine performs the same Thanks without a renderer: it posts to the
// Engine's Livewire endpoint directly. Both Livewire generations are in
// production use, and their payloads differ, so both are covered here.
for (const livewire of [2, 3] as const) {
  void test(`http engine thanks over livewire ${livewire}`, async (t) => {
    const tracker = await startFakeTracker({
      validCredentials: { username: "operator-user", password: "operator-pw" },
      livewire,
    });

    const siteId = `fake-http-v${livewire}`;
    const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-http-"));
    const sitesPath = join(tmpDir, "sites.json");
    writeFileSync(
      sitesPath,
      JSON.stringify({ sites: [{ id: siteId, base_url: tracker.baseUrl }] }),
    );

    const originalEnv = { ...process.env };
    process.env.SITES_CONFIG_PATH = sitesPath;
    process.env.CACHE_DIR = join(tmpDir, "cache");
    process.env.THANKS_ENGINE = "http";
    process.env[`${siteId.toUpperCase().replaceAll("-", "_")}_USERNAME`] = "operator-user";
    process.env[`${siteId.toUpperCase().replaceAll("-", "_")}_PASSWORD`] = "operator-pw";

    const { loadSites, getSiteCredentials } = await import("../src/config.ts");
    const { thank } = await import("../src/thank.ts");

    t.after(async () => {
      await tracker.close();
      rmSync(tmpDir, { recursive: true, force: true });
      process.env = originalEnv;
    });

    const sites = loadSites();
    const site = sites.get(siteId);
    assert.ok(site, "expected configured site");
    const { username, password } = getSiteCredentials(site);

    await t.test("logs in and thanks without a browser", async () => {
      await thank(siteId, "9876", username, password, site, "e2e");

      assert.deepEqual(tracker.logins, [{ username: "operator-user", ok: true }]);
      assert.equal(tracker.clicks.length, 1);
      // The bookmark button carries the same wire:click; the fake rejects the
      // call unless it names the thanks component, so reaching here proves the
      // right one was invoked.
      assert.deepEqual(tracker.clicks[0], { torrentId: "9876", authed: true });
    });

    await t.test("reuses the stored session and does not re-login", async () => {
      await thank(siteId, "12345", username, password, site, "e2e");

      assert.equal(tracker.logins.length, 1, "second thank should reuse the session cookie");
      assert.equal(tracker.clicks.length, 2);
      assert.deepEqual(tracker.clicks[1], { torrentId: "12345", authed: true });
    });

    await t.test("persists the session to disk so a restart need not re-login", () => {
      const cookies = join(tmpDir, "cache", "http-sessions", `${siteId}.json`);
      assert.ok(existsSync(cookies), "expected the cookie jar on disk");
    });

    // Livewire 2 disables the button once thanked; Livewire 3 renders it
    // unchanged and rejects the duplicate call instead. Either way the torrent
    // must not be counted as thanked twice.
    await t.test("a torrent already thanked is not thanked again", async () => {
      await thank(siteId, "9876", username, password, site, "e2e");

      assert.equal(tracker.clicks.length, 2, "the duplicate must not reach the Site as a thanks");
    });
  });
}
