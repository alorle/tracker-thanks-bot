import { envVarBase, type Config, type Site } from "./config.ts";
import { classifyRejection, type ClassifyRejection } from "./rejection.ts";
import { createBrowserContexts, enqueue, drainAll, type BrowserContexts } from "./browser.ts";
import { createBrowserThanks } from "./browser-thanks.ts";
import { createHttpThanks } from "./http-thanks.ts";
import { log } from "./log.ts";
import { torrentsThanked, torrentsSkipped, torrentsErrored, thankDuration } from "./metrics.ts";

export type ThankTarget = {
  site: Site;
  torrentId: string;
};

export class LoginFailedError extends Error {
  readonly site: Site;

  constructor(site: Site) {
    const base = envVarBase(site.id);
    super(`Login failed. Check your ${base}_USERNAME and ${base}_PASSWORD.`);
    this.name = "LoginFailedError";
    this.site = site;
  }
}

export class ThanksRefusedAsInvalidError extends Error {
  constructor(torrentId: string, message: string) {
    super(`The Site turned down the thanks call for torrent ${torrentId} as invalid: ${message}`);
    this.name = "ThanksRefusedAsInvalidError";
  }
}

export type SkipReason =
  "no_button" | "already_thanked" | "quota_exhausted" | "not_eligible" | "rejected";

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
  const detail = outcome.message ?? "unknown error";
  if (outcome.reason === "quota_exhausted") {
    return `Site is out of thanks for now, refusing torrent ${torrentId}: ${detail}`;
  }
  if (outcome.reason === "not_eligible") {
    return `Site will not take thanks for torrent ${torrentId}: ${detail}`;
  }
  return `Site rejected thanks for torrent ${torrentId}: ${detail}`;
}

async function place(
  outcome: ThanksOutcome,
  classify: ClassifyRejection,
  torrentId: string,
): Promise<ThanksOutcome> {
  if (outcome.status !== "skipped" || outcome.reason !== "rejected") return outcome;

  const message = outcome.message ?? "";
  const reason = await classify(message);
  if (reason === "protocol_error") throw new ThanksRefusedAsInvalidError(torrentId, message);
  if (reason === "other") return outcome;
  return { ...outcome, reason };
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
  closeAll: () => Promise<void>;
};

export function createThanks(
  config: Config,
  contexts: BrowserContexts = createBrowserContexts(config.cacheDir),
  classify: ClassifyRejection = classifyRejection,
): Thanks {
  const thankOverBrowser = createBrowserThanks(contexts);
  const thankOverHttp = createHttpThanks(config.cacheDir);

  /**
   * Thank one torrent, serialized per Site.
   *
   * The queue is what keeps two grabs on the same Site from logging in at once,
   * whichever engine is active.
   */
  function thank({ site, torrentId }: ThankTarget): Promise<ThanksOutcome> {
    const logPrefix = `auto-thanks:${site.id}`;
    return enqueue(site.id, async () => {
      const engine = config.thanksEngine === "http" ? thankOverHttp : thankOverBrowser;
      const stopTimer = thankDuration.startTimer({ site: site.id });
      try {
        const outcome = await place(await engine(torrentId, site, logPrefix), classify, torrentId);
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

  return { thank, drainAll, closeAll: contexts.closeAll };
}
