import type { Page } from "playwright";
import { envVarBase, type SiteConfig } from "./config.js";
import { log } from "./log.js";
import { torrentsThanked, torrentsSkipped, torrentsErrored, thankDuration, logins } from "./metrics.js";

export async function ensureLoggedIn(
  page: Page,
  username: string,
  password: string,
  site: SiteConfig,
  logPrefix: string,
): Promise<void> {
  if (!page.url().includes("/login")) return;

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
  const siteLabel = site.id;
  const stopTimer = thankDuration.startTimer({ site: siteLabel });

  try {
    const url = `${site.baseUrl}/torrents/${torrentId}`;
    log(logPrefix, `Navigating to torrent ${torrentId}...`);

    await page.goto(url);

    if (page.url().includes("/login")) {
      await ensureLoggedIn(page, username, password, site, logPrefix);
      await page.goto(url);
    }

    await page.waitForLoadState("networkidle");

    // @ts-expect-error -- runs in browser context where window.Livewire exists
    await page.waitForFunction(() => typeof window.Livewire !== "undefined");

    const thanksButton = page
      .locator(`button[wire\\:click="store(${torrentId})"]`)
      .filter({ hasText: "Agradecer" });
    const count = await thanksButton.count();

    if (count === 0) {
      log(logPrefix, `No thanks button found for torrent ${torrentId}. Skipping.`);
      torrentsSkipped.inc({ site: siteLabel, reason: "no_button" });
      return;
    }

    if (await thanksButton.isDisabled()) {
      log(logPrefix, `Torrent ${torrentId} already thanked. Skipping.`);
      torrentsSkipped.inc({ site: siteLabel, reason: "already_thanked" });
      return;
    }

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/livewire")),
      thanksButton.click(),
    ]);
    torrentsThanked.inc({ site: siteLabel });
    log(logPrefix, `Thanked torrent ${torrentId}. (status: ${response.status()})`);
  } catch (err) {
    torrentsErrored.inc({ site: siteLabel });
    throw err;
  } finally {
    stopTimer();
  }
}
