import type { Site } from "./config.ts";
import { freshPage, enqueue } from "./browser.ts";
import { thankTorrent } from "./thanks.ts";
import { thankTorrentHttp } from "./http-thanks.ts";

export type ThanksEngine = "browser" | "http";

export type ThankTarget = {
  site: Site;
  torrentId: string;
};

/**
 * Which engine performs the Thanks.
 *
 * "browser" drives Playwright (the original path); "http" talks to the Engine's
 * Livewire endpoint directly, which needs no renderer and so cannot be
 * OOM-killed. The flag exists so the two can be swapped without a redeploy of
 * a different image.
 */
export function getThanksEngine(): ThanksEngine {
  return process.env.THANKS_ENGINE === "http" ? "http" : "browser";
}

/**
 * Thank one torrent, serialized per Site.
 *
 * The queue is what keeps two grabs on the same Site from logging in at once,
 * whichever engine is active.
 */
export function thank({ site, torrentId }: ThankTarget): Promise<void> {
  const logPrefix = `auto-thanks:${site.id}`;
  return enqueue(site.id, async () => {
    if (getThanksEngine() === "http") {
      await thankTorrentHttp(torrentId, site, logPrefix);
      return;
    }
    const page = await freshPage(site.id);
    await thankTorrent(page, torrentId, site, logPrefix);
  });
}
