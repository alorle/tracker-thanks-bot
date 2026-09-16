import type { Page } from "playwright";
import { envVarBase, type SiteConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  torrentsThanked,
  torrentsSkipped,
  torrentsErrored,
  thankDuration,
  logins,
} from "./metrics.ts";

async function login(
  page: Page,
  username: string,
  password: string,
  site: SiteConfig,
  logPrefix: string,
): Promise<void> {
  log(logPrefix, "Login required. Submitting credentials...");

  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator(site.loginButtonSelector).click();
  await page.waitForLoadState("networkidle");

  if (page.url().includes("/login")) {
    logins.inc({ site: site.id, status: "failure" });
    const base = envVarBase(site.id);
    throw new Error(`Login failed. Check your ${base}_USERNAME and ${base}_PASSWORD.`);
  }

  logins.inc({ site: site.id, status: "success" });
  log(logPrefix, "Login successful.");
}

export async function thankTorrent(
  page: Page,
  torrentId: string,
  username: string,
  password: string,
  site: SiteConfig,
  logPrefix: string,
): Promise<void> {
  const stopTimer = thankDuration.startTimer({ site: site.id });

  try {
    const url = `${site.baseUrl}/torrents/${torrentId}`;
    log(logPrefix, `Navigating to torrent ${torrentId}...`);

    await page.goto(url);

    if (page.url().includes("/login")) {
      await login(page, username, password, site, logPrefix);
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
      log(logPrefix, `No thanks button found for torrent ${torrentId}. Skipping.`);
      torrentsSkipped.inc({ site: site.id, reason: "no_button" });
      return;
    }

    // Several matches would make the strict-mode calls below throw rather than
    // thank the torrent, and any one of them performs the same Thanks.
    const thanksButton = matches.first();

    if (await thanksButton.isDisabled()) {
      log(logPrefix, `Torrent ${torrentId} already thanked. Skipping.`);
      torrentsSkipped.inc({ site: site.id, reason: "already_thanked" });
      return;
    }

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/livewire")),
      thanksButton.click(),
    ]);
    torrentsThanked.inc({ site: site.id });
    log(logPrefix, `Thanked torrent ${torrentId}. (status: ${response.status()})`);
  } catch (err) {
    torrentsErrored.inc({ site: site.id });
    throw err;
  } finally {
    stopTimer();
  }
}
