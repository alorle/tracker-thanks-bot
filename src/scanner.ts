import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.ts";
import type { SitesMap } from "./config.ts";
import type { Thanks } from "./thank.ts";
import { parseTorrentComment } from "./url-parser.ts";
import type { QBittorrentClient } from "./qbittorrent.ts";
import { scansCompleted, scanDuration, scanTorrentsProcessed } from "./metrics.ts";

const PREFIX = "scanner";

export async function scanAllTorrents(
  sites: SitesMap,
  qbClient: QBittorrentClient,
  thanks: Thanks,
  delayMs: number,
): Promise<void> {
  log(PREFIX, "Starting torrent scan...");
  const stopTimer = scanDuration.startTimer();

  const torrents = await qbClient.listTorrents();
  log(PREFIX, `Found ${torrents.length} torrent(s) in qBittorrent.`);

  let siteTouched = false;
  let thankedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const torrent of torrents) {
    try {
      let comment: string;
      try {
        comment = await qbClient.getTorrentComment(torrent.hash);
      } catch (err) {
        log(PREFIX, `Error fetching comment for "${torrent.name}": ${String(err)}`);
        errorCount++;
        continue;
      }

      if (!comment) {
        skippedCount++;
        continue;
      }

      const target = parseTorrentComment(sites, comment);
      if (!target) {
        skippedCount++;
        continue;
      }

      // A scan walks every torrent at once; without this the Site would take
      // the whole batch as fast as the network allows, which is how an account
      // on a private tracker gets itself banned.
      if (siteTouched) await sleep(delayMs);
      siteTouched = true;

      const outcome = await thanks.thank(target);
      if (outcome.status === "thanked") thankedCount++;
      else skippedCount++;
    } catch (err) {
      log(PREFIX, `Error processing torrent "${torrent.name}": ${String(err)}`);
      errorCount++;
    }
  }

  scanTorrentsProcessed.set({ result: "thanked" }, thankedCount);
  scanTorrentsProcessed.set({ result: "skipped" }, skippedCount);
  scanTorrentsProcessed.set({ result: "error" }, errorCount);
  scansCompleted.inc({ status: errorCount > 0 ? "partial" : "success" });
  stopTimer();

  log(
    PREFIX,
    `Scan complete. Processed: ${thankedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`,
  );
}
