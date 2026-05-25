import { log } from "./log.js";
import { getSiteCredentials, type SitesMap } from "./config.js";
import { parseTorrentComment } from "./url-parser.js";
import { getPage, enqueue } from "./browser.js";
import { thankTorrent } from "./thanks.js";
import type { QBittorrentClient } from "./qbittorrent.js";
import { scansCompleted, scanDuration, scanTorrentsProcessed } from "./metrics.js";

const PREFIX = "scanner";

export async function scanAllTorrents(sites: SitesMap, qbClient: QBittorrentClient): Promise<void> {
  log(PREFIX, "Starting torrent scan...");
  const stopTimer = scanDuration.startTimer();

  const torrents = await qbClient.listTorrents();
  log(PREFIX, `Found ${torrents.length} torrent(s) in qBittorrent.`);

  let thankedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const torrent of torrents) {
    try {
      let comment: string;
      try {
        comment = await qbClient.getTorrentComment(torrent.hash);
      } catch (err) {
        log(PREFIX, `Error fetching comment for "${torrent.name}": ${err}`);
        errorCount++;
        continue;
      }

      if (!comment) {
        skippedCount++;
        continue;
      }

      const parsed = parseTorrentComment(sites, comment);
      if (!parsed) {
        skippedCount++;
        continue;
      }

      const site = sites.get(parsed.siteKey);
      if (!site) {
        skippedCount++;
        continue;
      }

      let credentials: { username: string; password: string };
      try {
        credentials = getSiteCredentials(site);
      } catch {
        skippedCount++;
        continue;
      }

      const logPrefix = `auto-thanks:${site.id}`;
      await enqueue(parsed.siteKey, async () => {
        const page = await getPage(parsed.siteKey);
        await thankTorrent(page, parsed.torrentId, credentials.username, credentials.password, site, logPrefix);
      });
      thankedCount++;
    } catch (err) {
      log(PREFIX, `Error processing torrent "${torrent.name}": ${err}`);
      errorCount++;
    }
  }

  scanTorrentsProcessed.set({ result: "thanked" }, thankedCount);
  scanTorrentsProcessed.set({ result: "skipped" }, skippedCount);
  scanTorrentsProcessed.set({ result: "error" }, errorCount);
  scansCompleted.inc({ status: errorCount > 0 ? "partial" : "success" });
  stopTimer();

  log(PREFIX, `Scan complete. Processed: ${thankedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
}
