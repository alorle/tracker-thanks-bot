import { getSiteCredentials, type SiteConfig, type SitesMap } from "./config.ts";
import { freshPage, enqueue } from "./browser.ts";
import { parseTorrentComment } from "./url-parser.ts";
import { thankTorrent } from "./thanks.ts";
import { thankTorrentHttp } from "./http-thanks.ts";

export type ThanksEngine = "browser" | "http";

export type ThankTarget = {
  site: SiteConfig;
  torrentId: string;
  username: string;
  password: string;
};

export type ResolvedThankTarget =
  | { ok: true; target: ThankTarget }
  | { ok: false; reason: "no_match"; siteId: null }
  | { ok: false; reason: "missing_credentials"; siteId: string; message: string };

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
 * Turn a qBittorrent torrent comment into everything `thank` needs, or the
 * reason it cannot be thanked. Shared by the webhook and the scan, which report
 * those reasons differently but resolve them identically.
 */
export function resolveThankTarget(sites: SitesMap, comment: string): ResolvedThankTarget {
  const parsed = parseTorrentComment(sites, comment);
  if (!parsed) return { ok: false, reason: "no_match", siteId: null };

  try {
    const { username, password } = getSiteCredentials(parsed.site);
    return {
      ok: true,
      target: { site: parsed.site, torrentId: parsed.torrentId, username, password },
    };
  } catch (err) {
    return {
      ok: false,
      reason: "missing_credentials",
      siteId: parsed.site.id,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Thank one torrent, serialized per Site.
 *
 * The queue is what keeps two grabs on the same Site from logging in at once,
 * whichever engine is active.
 */
export function thank({ site, torrentId, username, password }: ThankTarget): Promise<void> {
  const logPrefix = `auto-thanks:${site.id}`;
  return enqueue(site.id, async () => {
    if (getThanksEngine() === "http") {
      await thankTorrentHttp(torrentId, username, password, site, logPrefix);
      return;
    }
    const page = await freshPage(site.id);
    await thankTorrent(page, torrentId, username, password, site, logPrefix);
  });
}
