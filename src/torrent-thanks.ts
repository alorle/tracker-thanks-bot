import type { Site, SitesMap } from "./config.ts";
import { torrentIdIn } from "./engine.ts";
import type { QBittorrentClient } from "./qbittorrent.ts";
import type { ThankTarget, Thanks, ThanksOutcome } from "./thank.ts";

export type TorrentThanksResult =
  | { status: "no_comment" }
  | { status: "no_site"; comment: string }
  | { status: "site_paused"; target: ThankTarget }
  | { status: "thanked" | "skipped"; target: ThankTarget; outcome: ThanksOutcome };

export type TorrentThanks = (
  hash: string,
  options?: { waitForComment?: boolean; skipSite?: (site: Site) => boolean },
) => Promise<TorrentThanksResult>;

type CommentSource = Pick<QBittorrentClient, "getTorrentComment" | "getTorrentCommentWithRetry">;

function matchSite(sites: SitesMap, comment: string): ThankTarget | null {
  for (const site of sites.values()) {
    const torrentId = torrentIdIn(comment, site);
    if (torrentId) {
      return { site, torrentId };
    }
  }
  return null;
}

export function createTorrentThanks(
  sites: SitesMap,
  qbClient: CommentSource,
  thanks: Thanks,
): TorrentThanks {
  return async function thankTorrent(hash, { waitForComment = false, skipSite } = {}) {
    const comment = waitForComment
      ? await qbClient.getTorrentCommentWithRetry(hash)
      : await qbClient.getTorrentComment(hash);

    if (!comment) return { status: "no_comment" };

    const target = matchSite(sites, comment);
    if (!target) return { status: "no_site", comment };
    if (skipSite?.(target.site)) return { status: "site_paused", target };

    const outcome = await thanks.thank(target);
    return { status: outcome.status, target, outcome };
  };
}
