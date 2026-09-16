import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker } from "./fake-tracker.ts";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";
import { metricValue } from "./metric-probe.ts";
import { loadConfig } from "../src/config.ts";
import { createThanks } from "../src/thank.ts";
import { QBittorrentClient } from "../src/qbittorrent.ts";
import { scanAllTorrents } from "../src/scanner.ts";

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
  await scanAllTorrents(
    config.sites,
    new QBittorrentClient(config.qbittorrent),
    createThanks(config),
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
