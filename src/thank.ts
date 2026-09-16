import type { Config, Site } from "./config.ts";
import { createBrowserContexts, enqueue, drainAll, type BrowserContexts } from "./browser.ts";
import { createBrowserThanks } from "./browser-thanks.ts";
import { createHttpThanks } from "./http-thanks.ts";
import { log } from "./log.ts";
import { torrentsThanked, torrentsSkipped, torrentsErrored, thankDuration } from "./metrics.ts";

export type ThankTarget = {
  site: Site;
  torrentId: string;
};

export type SkipReason = "no_button" | "already_thanked" | "rejected";

export type ThanksOutcome =
  | { status: "thanked"; detail: string }
  | { status: "skipped"; reason: SkipReason; message?: string };

export type ThanksAdapter = (
  torrentId: string,
  site: Site,
  logPrefix: string,
) => Promise<ThanksOutcome>;

function skipMessage(outcome: { reason: SkipReason; message?: string }, torrentId: string): string {
  if (outcome.reason === "no_button") {
    return `No thanks button found for torrent ${torrentId}. Skipping.`;
  }
  if (outcome.reason === "already_thanked") {
    return `Torrent ${torrentId} already thanked. Skipping.`;
  }
  return `Site rejected thanks for torrent ${torrentId}: ${outcome.message ?? "unknown error"}`;
}

function record(outcome: ThanksOutcome, site: Site, torrentId: string, logPrefix: string): void {
  if (outcome.status === "thanked") {
    torrentsThanked.inc({ site: site.id });
    log(logPrefix, `Thanked torrent ${torrentId}. (${outcome.detail})`);
    return;
  }
  torrentsSkipped.inc({ site: site.id, reason: outcome.reason });
  log(logPrefix, skipMessage(outcome, torrentId));
}

export type Thanks = {
  thank: (target: ThankTarget) => Promise<void>;
  drainAll: () => Promise<void>;
  closeAll: () => Promise<void>;
};

export function createThanks(
  config: Config,
  contexts: BrowserContexts = createBrowserContexts(config.cacheDir),
): Thanks {
  const thankOverBrowser = createBrowserThanks(contexts);
  const thankOverHttp = createHttpThanks(config.cacheDir);

  /**
   * Thank one torrent, serialized per Site.
   *
   * The queue is what keeps two grabs on the same Site from logging in at once,
   * whichever engine is active.
   */
  function thank({ site, torrentId }: ThankTarget): Promise<void> {
    const logPrefix = `auto-thanks:${site.id}`;
    return enqueue(site.id, async () => {
      const engine = config.thanksEngine === "http" ? thankOverHttp : thankOverBrowser;
      const stopTimer = thankDuration.startTimer({ site: site.id });
      try {
        record(await engine(torrentId, site, logPrefix), site, torrentId, logPrefix);
      } catch (err) {
        torrentsErrored.inc({ site: site.id });
        throw err;
      } finally {
        stopTimer();
      }
    });
  }

  return { thank, drainAll, closeAll: contexts.closeAll };
}
