import type { SiteConfig, SitesMap } from "./config.ts";

export type ParsedTorrentUrl = {
  site: SiteConfig;
  torrentId: string;
};

export function parseTorrentComment(sites: SitesMap, comment: string): ParsedTorrentUrl | null {
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
