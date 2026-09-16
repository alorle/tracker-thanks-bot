import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker, type ThanksClick } from "./fake-tracker.ts";
import type { Site } from "../src/config.ts";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";
import { metricValue } from "./metric-probe.ts";

// Assert what a step added to the Site's click log rather than the running
// total: a total makes every later step fail once an earlier one does, and
// reports "expected 3 to equal 2" instead of naming the step that broke.
function assertThanked(
  clicks: ThanksClick[],
  before: number,
  expected: string[],
  message: string,
): void {
  const added = clicks.slice(before);
  assert.deepEqual(
    added.map((click) => click.torrentId),
    expected,
    message,
  );
  assert.ok(
    added.every((click) => click.authed),
    "every thanks must be sent with an authenticated session",
  );
}

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
  // Without this the Operator's own THANKS_ENGINE (direnv exports .env into
  // every shell here) silently turns this into a second http-engine test.
  process.env.THANKS_ENGINE = "browser";
  process.env.FAKE_SITE_USERNAME = "operator-user";
  process.env.FAKE_SITE_PASSWORD = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;

  const { loadConfig } = await import("../src/config.ts");
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
    const sites = loadConfig().sites;
    assert.equal(sites.size, 1);
    const site = sites.get("fake-site");
    assert.ok(site, "expected site keyed by configured id");
    assert.equal(site.id, "fake-site");
    assert.equal(site.baseUrl, tracker.baseUrl);
    assert.equal(site.loginButtonSelector, 'button[type="submit"]');
  });

  await t.test("identifies the Site from a qBittorrent comment", async () => {
    const config = loadConfig();
    assert.ok(config.qbittorrent, "expected the fake qBittorrent in the config");
    const qbClient = new QBittorrentClient(config.qbittorrent);
    const comment = await qbClient.getTorrentComment(torrentHash);
    assert.match(comment, /\/torrents\/9876/);

    const parsed = parseTorrentComment(config.sites, comment);
    assert.ok(parsed, "expected parser to match the configured base_url");
    assert.equal(parsed.site.id, "fake-site");
    assert.equal(parsed.torrentId, trackerTorrentId);
  });

  await t.test("derives credentials from the Site id", () => {
    const site = loadConfig().sites.get("fake-site");
    assert.ok(site, "expected configured site");
    assert.equal(site.username, "operator-user");
    assert.equal(site.password, "operator-pw");
  });

  await t.test("logs into the tracker and clicks the thanks button", async () => {
    const sites = loadConfig().sites;
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");

    const clicksBefore = tracker.clicks.length;
    await thank({ site, torrentId: trackerTorrentId });

    assert.equal(tracker.logins.length, 1, "tracker should have observed one login");
    assert.deepEqual(tracker.logins[0], { username: "operator-user", ok: true });

    assertThanked(
      tracker.clicks,
      clicksBefore,
      [trackerTorrentId],
      "the grabbed torrent must be thanked exactly once",
    );
  });

  await t.test("reuses the persistent session and does not re-login", async () => {
    const sites = loadConfig().sites;
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");

    // Add a second torrent on the same Site to confirm session reuse.
    const secondTorrentId = "12345";
    const clicksBefore = tracker.clicks.length;
    await thank({ site, torrentId: secondTorrentId });

    assert.equal(tracker.logins.length, 1, "second thank should reuse the cached session");
    assertThanked(
      tracker.clicks,
      clicksBefore,
      [secondTorrentId],
      "the second torrent must be thanked exactly once",
    );
  });

  // Regression: a renderer killed mid-scan (the container's memory ceiling is
  // how it happens in production) used to poison every later torrent, because
  // the crashed page stayed cached and Playwright cannot revive one. Every
  // navigation after it failed with "Page crashed" until the process restarted.
  await t.test("a crashed page does not poison the next torrent", async () => {
    const sites = loadConfig().sites;
    const site = sites.get("fake-site");
    assert.ok(site, "expected configured site");

    await enqueue("fake-site", async () => {
      const page = await freshPage("fake-site");
      // chrome://crash kills the renderer exactly like the OOM killer does.
      await page.goto("chrome://crash").catch(() => {});
    });

    const thirdTorrentId = "24680";
    const clicksBefore = tracker.clicks.length;
    await thank({ site, torrentId: thirdTorrentId });

    assertThanked(
      tracker.clicks,
      clicksBefore,
      [thirdTorrentId],
      "the torrent after a crash must still be thanked",
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
      rejects: ["5555"],
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

    const { loadConfig } = await import("../src/config.ts");
    const { thank } = await import("../src/thank.ts");

    t.after(async () => {
      await tracker.close();
      rmSync(tmpDir, { recursive: true, force: true });
      process.env = originalEnv;
    });

    const sites = loadConfig().sites;
    const site = sites.get(siteId);
    assert.ok(site, "expected configured site");

    await t.test("logs in and thanks without a browser", async () => {
      const clicksBefore = tracker.clicks.length;
      const thankedBefore = await metricValue("tracker_torrents_thanked_total", { site: siteId });
      await thank({ site, torrentId: "9876" });

      assert.deepEqual(tracker.logins, [{ username: "operator-user", ok: true }]);
      // The bookmark button is rendered first and carries the same wire:click;
      // the fake also refuses a call that does not name the thanks component,
      // so reaching here proves the right one was invoked.
      assertThanked(tracker.clicks, clicksBefore, ["9876"], "the torrent must be thanked once");
      assert.equal(
        (await metricValue("tracker_torrents_thanked_total", { site: siteId })) - thankedBefore,
        1,
        "a thanks the Site accepted must be counted as one",
      );

      // The session cookie is handed out on the redirect that answers the login
      // POST, and a browser follows that hop with a bodyless GET.
      const loginPost = tracker.requests.findIndex(
        (request) => request.method === "POST" && request.path === "/login",
      );
      assert.deepEqual(
        tracker.requests[loginPost + 1],
        { method: "GET", path: "/" },
        "the post-login redirect must be followed as a GET",
      );
    });

    await t.test("reuses the stored session and does not re-login", async () => {
      const clicksBefore = tracker.clicks.length;
      await thank({ site, torrentId: "12345" });

      assert.equal(tracker.logins.length, 1, "second thank should reuse the session cookie");
      assertThanked(
        tracker.clicks,
        clicksBefore,
        ["12345"],
        "the second torrent must be thanked once",
      );
    });

    await t.test("persists the session to disk so a restart need not re-login", () => {
      const cookies = join(tmpDir, "cache", "http-sessions", `${siteId}.json`);
      assert.ok(existsSync(cookies), "expected the cookie jar on disk");
      assert.equal(
        statSync(cookies).mode & 0o777,
        0o600,
        "a session cookie is a credential: nobody else on the host may read it",
      );
      // The Site also serves a nameless cookie; storing it would send garbage
      // back on every later request.
      const stored = JSON.parse(readFileSync(cookies, "utf-8")) as Record<string, string>;
      assert.deepEqual(Object.keys(stored), ["SID"], "only well-formed cookies belong in the jar");
    });

    // Livewire 2 disables the button once thanked; Livewire 3 renders it
    // unchanged and rejects the duplicate call instead. Either way the torrent
    // must not be counted as thanked twice.
    await t.test("a torrent already thanked is not thanked again", async () => {
      // Livewire 2 answers with a disabled button, so the duplicate is caught
      // before the call; Livewire 3 answers by rejecting the call itself.
      const reason = livewire === 2 ? "already_thanked" : "rejected";
      const clicksBefore = tracker.clicks.length;
      const thankedBefore = await metricValue("tracker_torrents_thanked_total", { site: siteId });
      const skippedBefore = await metricValue("tracker_torrents_skipped_total", {
        site: siteId,
        reason,
      });

      await thank({ site, torrentId: "9876" });

      assertThanked(
        tracker.clicks,
        clicksBefore,
        [],
        "the duplicate must not reach the Site as a thanks",
      );
      assert.equal(
        (await metricValue("tracker_torrents_skipped_total", { site: siteId, reason })) -
          skippedBefore,
        1,
        `the duplicate must be reported as "${reason}"`,
      );
      assert.equal(
        (await metricValue("tracker_torrents_thanked_total", { site: siteId })) - thankedBefore,
        0,
        "a duplicate must never be counted as a thanks",
      );
    });

    // The Site can also turn a thanks down with the button still enabled: a
    // quota reached, a torrent that is not the Operator's. The bot has to read
    // the refusal out of the response, which is the only place it is reported.
    await t.test("a thanks the Site turns down is reported, not counted", async () => {
      const clicksBefore = tracker.clicks.length;
      const thankedBefore = await metricValue("tracker_torrents_thanked_total", { site: siteId });
      const skippedBefore = await metricValue("tracker_torrents_skipped_total", {
        site: siteId,
        reason: "rejected",
      });

      await thank({ site, torrentId: "5555" });

      assertThanked(tracker.clicks, clicksBefore, [], "a refused thanks reached nothing");
      assert.equal(
        (await metricValue("tracker_torrents_skipped_total", {
          site: siteId,
          reason: "rejected",
        })) - skippedBefore,
        1,
        "the refusal must be reported as a rejected skip",
      );
      assert.equal(
        (await metricValue("tracker_torrents_thanked_total", { site: siteId })) - thankedBefore,
        0,
        "a refused thanks must never be counted as one",
      );
    });
  });
}

/** One Site in sites.json, its credentials in env, and the engine under test. */
async function configureSite(
  t: TestContext,
  {
    siteId,
    baseUrl,
    engine,
    password = "operator-pw",
  }: { siteId: string; baseUrl: string; engine: "browser" | "http"; password?: string },
): Promise<Site> {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-e2e-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(sitesPath, JSON.stringify({ sites: [{ id: siteId, base_url: baseUrl }] }));

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.CACHE_DIR = join(tmpDir, "cache");
  process.env.THANKS_ENGINE = engine;
  const base = siteId.toUpperCase().replaceAll("-", "_");
  process.env[`${base}_USERNAME`] = "operator-user";
  process.env[`${base}_PASSWORD`] = password;

  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  const { loadConfig } = await import("../src/config.ts");
  const site = loadConfig().sites.get(siteId);
  assert.ok(site, "expected the configured site");
  return site;
}

// Wrong credentials are how a Site answers after the Operator rotates a
// password, and the bot must say so: silently carrying on would thank nothing
// night after night while every metric stayed clean.
for (const engine of ["http", "browser"] as const) {
  void test(`the ${engine} engine surfaces a login the Site refused`, async (t) => {
    const tracker = await startFakeTracker({
      validCredentials: { username: "operator-user", password: "operator-pw" },
    });
    const site = await configureSite(t, {
      siteId: `bad-login-${engine}`,
      baseUrl: tracker.baseUrl,
      engine,
      password: "the-wrong-password",
    });

    const { thank } = await import("../src/thank.ts");
    const { closeAll } = await import("../src/browser.ts");
    t.after(async () => {
      await closeAll();
      await tracker.close();
    });

    const failuresBefore = await metricValue("tracker_logins_total", {
      site: site.id,
      status: "failure",
    });

    await assert.rejects(
      () => thank({ site, torrentId: "9876" }),
      /Login failed/,
      "the Operator has to be told which credentials to check",
    );

    assert.equal(tracker.clicks.length, 0, "nothing may be thanked without a session");
    assert.deepEqual(tracker.logins, [{ username: "operator-user", ok: false }]);
    assert.equal(
      (await metricValue("tracker_logins_total", { site: site.id, status: "failure" })) -
        failuresBefore,
      1,
      "a refused login must be counted as one",
    );
  });
}

// On a Livewire 2 Site the button comes back disabled once thanked. Clicking it
// anyway is not a no-op: Playwright waits for it to become actionable and the
// thank hangs until it times out.
void test("the browser engine skips a torrent the Site shows as already thanked", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
    livewire: 2,
  });
  const site = await configureSite(t, {
    siteId: "browser-duplicate",
    baseUrl: tracker.baseUrl,
    engine: "browser",
  });

  const { thank } = await import("../src/thank.ts");
  const { closeAll } = await import("../src/browser.ts");
  t.after(async () => {
    await closeAll();
    await tracker.close();
  });

  await thank({ site, torrentId: "9876" });
  assert.equal(tracker.clicks.length, 1, "the first thanks must reach the Site");

  const skippedBefore = await metricValue("tracker_torrents_skipped_total", {
    site: site.id,
    reason: "already_thanked",
  });

  await thank({ site, torrentId: "9876" });

  assert.equal(tracker.clicks.length, 1, "a disabled button must not be clicked again");
  assert.equal(
    (await metricValue("tracker_torrents_skipped_total", {
      site: site.id,
      reason: "already_thanked",
    })) - skippedBefore,
    1,
    "the skip must name the reason the Operator would look for",
  );
});
