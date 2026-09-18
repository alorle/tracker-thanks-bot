import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.ts";
import type { QBittorrentClient } from "./qbittorrent.ts";
import type { TorrentThanks } from "./torrent-thanks.ts";
import { scansCompleted, scanDuration, scanTorrentsProcessed } from "./metrics.ts";

const PREFIX = "scanner";

export async function scanAllTorrents(
  qbClient: Pick<QBittorrentClient, "listTorrents">,
  thankTorrent: TorrentThanks,
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
      // A scan walks every torrent at once; without this the Site would take
      // the whole batch as fast as the network allows, which is how an account
      // on a private tracker gets itself banned.
      if (siteTouched) {
        await sleep(delayMs);
        siteTouched = false;
      }

      const result = await thankTorrent(torrent.hash);
      if (result.status === "no_comment" || result.status === "no_site") {
        skippedCount++;
        continue;
      }

      siteTouched = true;
      if (result.status === "thanked") thankedCount++;
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
