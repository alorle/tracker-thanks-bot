import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTracker } from "./fake-tracker.ts";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";

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

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.CACHE_DIR = join(tmpDir, "cache");
  process.env.THANKS_ENGINE = "http";
  process.env.PACED_USERNAME = "operator-user";
  process.env.PACED_PASSWORD = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;
  process.env.SCAN_DELAY_MS = "300";

  const { loadSites } = await import("../src/config.ts");
  const { QBittorrentClient } = await import("../src/qbittorrent.ts");
  const { scanAllTorrents } = await import("../src/scanner.ts");

  t.after(async () => {
    await tracker.close();
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  await scanAllTorrents(loadSites(), QBittorrentClient.fromEnv());

  assert.equal(tracker.clicks.length, 2, "both matching torrents must be thanked");
  const [first, second] = tracker.clicks;
  assert.ok(first && second, "expected two clicks to compare");
  const gap = second.at - first.at;
  assert.ok(gap >= 300, `expected the configured delay between the two Site calls, got ${gap}ms`);
});
