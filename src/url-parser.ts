import type { SitesMap } from "./config.ts";
import type { ThankTarget } from "./thank.ts";

export function parseTorrentComment(sites: SitesMap, comment: string): ThankTarget | null {
  for (const site of sites.values()) {
    const escaped = site.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}/torrents/(\\d+)`);
    const match = comment.match(pattern);
    if (match?.[1]) {
      return { site, torrentId: match[1] };
    }
  }
  return null;
}
