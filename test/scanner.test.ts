import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker } from "./fake-tracker.ts";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";
import { metricValue } from "./metric-probe.ts";
import { loadConfig, type Site, type SitesMap } from "../src/config.ts";
import { createThanks, type Thanks } from "../src/thank.ts";
import { QBittorrentClient } from "../src/qbittorrent.ts";
import { scanAllTorrents } from "../src/scanner.ts";
import { createTorrentThanks } from "../src/torrent-thanks.ts";

// A scan walks every torrent in one go. Over HTTP there is no renderer to slow
// it down, so without pacing the Site takes the whole batch at network speed.
void test("the scan paces its calls to the Site", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
    livewire: 3,
  });

  const qbit = await startFakeQBittorrent({
    torrents: new Map([
      ["aaaa", { name: "First", comment: `${tracker.baseUrl}/torrents/9876` }],
      ["bbbb", { name: "Second", comment: `${tracker.baseUrl}/torrents/12345` }],
      ["cccc", { name: "Unrelated", comment: "no site url here" }],
    ]),
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-scan-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(sitesPath, JSON.stringify({ sites: [{ id: "paced", base_url: tracker.baseUrl }] }));

  const config = loadConfig({
    SITES_CONFIG_PATH: sitesPath,
    CACHE_DIR: join(tmpDir, "cache"),
    THANKS_ENGINE: "http",
    PACED_USERNAME: "operator-user",
    PACED_PASSWORD: "operator-pw",
    QBIT_URL: qbit.baseUrl,
    QBIT_USERNAME: "qbit-user",
    QBIT_PASSWORD: "qbit-pw",
    SCAN_DELAY_MS: "300",
  });

  t.after(async () => {
    await tracker.close();
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const scansBefore = await metricValue("tracker_scans_completed_total", { status: "success" });
  const startedAt = Date.now();
  assert.ok(config.qbittorrent, "expected the fake qBittorrent in the config");
  const qbClient = new QBittorrentClient(config.qbittorrent);
  await scanAllTorrents(
    qbClient,
    createTorrentThanks(config.sites, qbClient, createThanks(config)),
    config.scan.delayMs,
  );

  assert.equal(tracker.clicks.length, 2, "both matching torrents must be thanked");
  const [first, second] = tracker.clicks;
  assert.ok(first && second, "expected two clicks to compare");
  const gap = second.at - first.at;
  assert.ok(gap >= 300, `expected the configured delay between the two Site calls, got ${gap}ms`);
  // The delay pays for the previous call, so the first torrent must not wait.
  assert.ok(
    first.at - startedAt < 300,
    `the first torrent must not be delayed, waited ${first.at - startedAt}ms`,
  );

  // The gauges are the only report a scan leaves behind: the Operator reads
  // them in Grafana, nobody reads the log lines.
  assert.equal(await metricValue("tracker_scan_last_torrents_processed", { result: "thanked" }), 2);
  assert.equal(await metricValue("tracker_scan_last_torrents_processed", { result: "skipped" }), 1);
  assert.equal(await metricValue("tracker_scan_last_torrents_processed", { result: "error" }), 0);
  assert.equal(
    (await metricValue("tracker_scans_completed_total", { status: "success" })) - scansBefore,
    1,
    "a scan with no errors must be reported as a success, not a partial run",
  );
});

// The scan's own tally used to count every torrent that did not throw as
// thanked, so a night where the Site had already been thanked for everything
// still reported a full house in Grafana.
void test("a torrent the Site does not thank is counted as skipped", async (t) => {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
    livewire: 3,
    rejects: ["5555"],
  });

  const qbit = await startFakeQBittorrent({
    torrents: new Map([
      ["aaaa", { name: "Fresh", comment: `${tracker.baseUrl}/torrents/9876` }],
      ["bbbb", { name: "Refused", comment: `${tracker.baseUrl}/torrents/5555` }],
    ]),
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-tally-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(sitesPath, JSON.stringify({ sites: [{ id: "tally", base_url: tracker.baseUrl }] }));

  const config = loadConfig({
    SITES_CONFIG_PATH: sitesPath,
    CACHE_DIR: join(tmpDir, "cache"),
    THANKS_ENGINE: "http",
    TALLY_USERNAME: "operator-user",
    TALLY_PASSWORD: "operator-pw",
    QBIT_URL: qbit.baseUrl,
    QBIT_USERNAME: "qbit-user",
    QBIT_PASSWORD: "qbit-pw",
    SCAN_DELAY_MS: "0",
  });

  t.after(async () => {
    await tracker.close();
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  assert.ok(config.qbittorrent, "expected the fake qBittorrent in the config");
  const qbClient = new QBittorrentClient(config.qbittorrent);
  await scanAllTorrents(
    qbClient,
    createTorrentThanks(config.sites, qbClient, createThanks(config)),
    config.scan.delayMs,
  );

  assert.equal(tracker.clicks.length, 1, "only the torrent the Site accepted is a thanks");
  assert.equal(
    await metricValue("tracker_scan_last_torrents_processed", { result: "thanked" }),
    1,
    "the refused torrent must not inflate the scan's thanked count",
  );
  assert.equal(
    await metricValue("tracker_scan_last_torrents_processed", { result: "skipped" }),
    1,
    "it belongs in skipped, which is where the Operator would look for it",
  );
  assert.equal(
    await metricValue("tracker_scan_last_torrents_processed", { result: "error" }),
    0,
    "a Site turning a thanks down is not an error",
  );
});

function pausableSites(): SitesMap {
  const make = (id: string, baseUrl: string): Site => ({
    id,
    baseUrl,
    loginButtonSelector: 'button[type="submit"]',
    username: "operator-user",
    password: "operator-pw",
  });
  return new Map([
    ["capped", make("capped", "https://capped.example.com")],
    ["open", make("open", "https://open.example.com")],
  ]);
}

void test("a Site that runs out of thanks is left alone for the rest of the scan", async () => {
  const comments = new Map([
    ["h1", "https://capped.example.com/torrents/1"],
    ["h2", "https://capped.example.com/torrents/2"],
    ["h3", "https://open.example.com/torrents/3"],
    ["h4", "https://capped.example.com/torrents/4"],
  ]);

  const qbClient = {
    listTorrents: () =>
      Promise.resolve([...comments.keys()].map((hash) => ({ hash, name: `Torrent ${hash}` }))),
    getTorrentComment: (hash: string) => Promise.resolve(comments.get(hash) ?? ""),
    getTorrentCommentWithRetry: (hash: string) => Promise.resolve(comments.get(hash) ?? ""),
  };

  const attempted: string[] = [];
  const thanks: Thanks = {
    thank: ({ site, torrentId }) => {
      attempted.push(`${site.id}/${torrentId}`);
      return Promise.resolve(
        site.id === "capped"
          ? { status: "skipped", reason: "quota_exhausted", message: "límite alcanzado" }
          : { status: "thanked", detail: "clicked" },
      );
    },
    drainAll: () => Promise.resolve(),
    closeAll: () => Promise.resolve(),
  };

  await scanAllTorrents(qbClient, createTorrentThanks(pausableSites(), qbClient, thanks), 0);

  assert.deepEqual(
    attempted,
    ["capped/1", "open/3"],
    "once a Site says it is out of thanks the scan must stop calling it, and only it",
  );
});
