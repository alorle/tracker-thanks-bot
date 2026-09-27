import type { Config, Site } from "./config.ts";
import { classifyRejection, type ClassifyRejection } from "./rejection.ts";
import { enqueue, drainAll } from "./queue.ts";
import { createHttpThanks, type ThanksAnswer } from "./http-thanks.ts";
import { log } from "./log.ts";
import { torrentsThanked, torrentsSkipped, torrentsErrored, thankDuration } from "./metrics.ts";

export type ThankTarget = {
  site: Site;
  torrentId: string;
};

export type SkipReason =
  "no_button" | "already_thanked" | "quota_exhausted" | "not_eligible" | "rejected";

export type ThanksOutcome =
  | { status: "thanked"; detail: string }
  | { status: "skipped"; reason: SkipReason; message?: string };

function skipMessage(outcome: { reason: SkipReason; message?: string }, torrentId: string): string {
  if (outcome.reason === "no_button") {
    return `No thanks button found for torrent ${torrentId}. Skipping.`;
  }
  if (outcome.reason === "already_thanked") {
    return `Torrent ${torrentId} already thanked. Skipping.`;
  }
  const detail = outcome.message ?? "unknown error";
  if (outcome.reason === "quota_exhausted") {
    return `Site is out of thanks for now, refusing torrent ${torrentId}: ${detail}`;
  }
  if (outcome.reason === "not_eligible") {
    return `Site will not take thanks for torrent ${torrentId}: ${detail}`;
  }
  return `Site rejected thanks for torrent ${torrentId}: ${detail}`;
}

async function place(answer: ThanksAnswer, classify: ClassifyRejection): Promise<ThanksOutcome> {
  if (answer.status !== "refused") return answer;

  const reason = await classify(answer.message);
  return {
    status: "skipped",
    reason: reason === "other" ? "rejected" : reason,
    message: answer.message,
  };
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
  thank: (target: ThankTarget) => Promise<ThanksOutcome>;
  drainAll: () => Promise<void>;
};

export function createThanks(
  config: Config,
  classify: ClassifyRejection = classifyRejection,
): Thanks {
  const thankOverHttp = createHttpThanks(config.cacheDir);

  /**
   * Thank one torrent, serialized per Site.
   *
   * The queue is what keeps two grabs on the same Site from logging in at once.
   */
  function thank({ site, torrentId }: ThankTarget): Promise<ThanksOutcome> {
    const logPrefix = `auto-thanks:${site.id}`;
    return enqueue(site.id, async () => {
      const stopTimer = thankDuration.startTimer({ site: site.id });
      try {
        const outcome = await place(await thankOverHttp(torrentId, site, logPrefix), classify);
        record(outcome, site, torrentId, logPrefix);
        return outcome;
      } catch (err) {
        torrentsErrored.inc({ site: site.id });
        throw err;
      } finally {
        stopTimer();
      }
    });
  }

  return { thank, drainAll };
}
