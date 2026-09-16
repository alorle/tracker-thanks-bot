import type { Config, Site } from "./config.ts";
import { createBrowserContexts, enqueue, drainAll, type BrowserContexts } from "./browser.ts";
import { createBrowserThanks } from "./browser-thanks.ts";
import { createHttpThanks } from "./http-thanks.ts";

export type ThankTarget = {
  site: Site;
  torrentId: string;
};

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
      await engine(torrentId, site, logPrefix);
    });
  }

  return { thank, drainAll, closeAll: contexts.closeAll };
}
