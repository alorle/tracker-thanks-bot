import type { SitesMap } from "./config.ts";
import type { QBittorrentClient } from "./qbittorrent.ts";
import type { ThankTarget, Thanks, ThanksOutcome } from "./thank.ts";

export type TorrentThanksResult =
  | { status: "no_comment" }
  | { status: "no_site"; comment: string }
  | { status: "thanked" | "skipped"; target: ThankTarget; outcome: ThanksOutcome };

export type TorrentThanks = (
  hash: string,
  options?: { waitForComment?: boolean },
) => Promise<TorrentThanksResult>;

type CommentSource = Pick<QBittorrentClient, "getTorrentComment" | "getTorrentCommentWithRetry">;

function matchSite(sites: SitesMap, comment: string): ThankTarget | null {
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

export function createTorrentThanks(
  sites: SitesMap,
  qbClient: CommentSource,
  thanks: Thanks,
): TorrentThanks {
  return async function thankTorrent(hash, { waitForComment = false } = {}) {
    const comment = waitForComment
      ? await qbClient.getTorrentCommentWithRetry(hash)
      : await qbClient.getTorrentComment(hash);

    if (!comment) return { status: "no_comment" };

    const target = matchSite(sites, comment);
    if (!target) return { status: "no_site", comment };

    const outcome = await thanks.thank(target);
    return { status: outcome.status, target, outcome };
  };
}
