import type { Page } from "playwright";
import type { Site } from "./config.ts";
import { log } from "./log.ts";
import type { BrowserContexts } from "./browser.ts";
import { LoginFailedError, type ThanksAdapter } from "./thank.ts";
import { logins } from "./metrics.ts";

async function login(page: Page, site: Site, logPrefix: string): Promise<void> {
  log(logPrefix, "Login required. Submitting credentials...");

  await page.locator('input[name="username"]').fill(site.username);
  await page.locator('input[name="password"]').fill(site.password);
  await page.locator(site.loginButtonSelector).click();
  await page.waitForLoadState("networkidle");

  if (page.url().includes("/login")) {
    logins.inc({ site: site.id, status: "failure" });
    throw new LoginFailedError(site);
  }

  logins.inc({ site: site.id, status: "success" });
  log(logPrefix, "Login successful.");
}

export function createBrowserThanks(contexts: BrowserContexts): ThanksAdapter {
  return async function thankTorrent(torrentId, site, logPrefix) {
    const page = await contexts.freshPage(site.id);
    const url = `${site.baseUrl}/torrents/${torrentId}`;
    log(logPrefix, `Navigating to torrent ${torrentId}...`);

    await page.goto(url);

    if (page.url().includes("/login")) {
      await login(page, site, logPrefix);
      await page.goto(url);
    }

    await page.waitForLoadState("networkidle");

    // Evaluated by the page, not by us: kept as an expression string so that
    // nothing which rewrites this file (bundler, instrumentation) can ship code
    // into the browser that only runs here.
    await page.waitForFunction("typeof window.Livewire !== 'undefined'");

    const matches = page
      .locator(`button[wire\\:click="store(${torrentId})"]`)
      .filter({ hasText: "Agradecer" });

    if ((await matches.count()) === 0) {
      return { status: "skipped", reason: "no_button" };
    }

    // Several matches would make the strict-mode calls below throw rather than
    // thank the torrent, and any one of them performs the same Thanks.
    const thanksButton = matches.first();

    if (await thanksButton.isDisabled()) {
      return { status: "skipped", reason: "already_thanked" };
    }

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/livewire")),
      thanksButton.click(),
    ]);
    return { status: "thanked", detail: `status: ${response.status()}` };
  };
}
