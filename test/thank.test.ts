import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config, type Site } from "../src/config.ts";
import type { BrowserContexts } from "../src/browser.ts";
import { createThanks } from "../src/thank.ts";
import { histogramCount, metricValue } from "./metric-probe.ts";

type SpyContexts = BrowserContexts & { opened: string[] };

function stubContexts(): SpyContexts {
  const opened: string[] = [];
  return {
    opened,
    getContext: () => Promise.reject(new Error("the seam must not reach for a context")),
    freshPage: (siteKey: string) => {
      opened.push(siteKey);
      return Promise.reject(new Error("browser engine reached"));
    },
    closeAll: () => Promise.resolve(),
  };
}

function configuredSite(
  t: TestContext,
  id: string,
  engine?: string,
): { config: Config; site: Site } {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-seam-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const path = join(tmpDir, "sites.json");
  writeFileSync(path, JSON.stringify({ sites: [{ id, base_url: "http://127.0.0.1:1" }] }));

  const base = id.toUpperCase().replaceAll("-", "_");
  const config = loadConfig({
    SITES_CONFIG_PATH: path,
    CACHE_DIR: join(tmpDir, "cache"),
    ...(engine === undefined ? {} : { THANKS_ENGINE: engine }),
    [`${base}_USERNAME`]: "operator-user",
    [`${base}_PASSWORD`]: "operator-pw",
  });

  const site = config.sites.get(id);
  assert.ok(site, "expected the configured Site");
  return { config, site };
}

void test("an unset THANKS_ENGINE sends a Site to Playwright, not to the endpoint", async (t) => {
  const { config, site } = configuredSite(t, "picks-browser");
  const contexts = stubContexts();

  await assert.rejects(
    () => createThanks(config, contexts).thank({ site, torrentId: "9876" }),
    /browser engine reached/,
    "an unset THANKS_ENGINE must reach the Playwright engine",
  );
  assert.deepEqual(contexts.opened, ["picks-browser"], "the page must be opened for that Site");
});

void test("the http engine thanks without ever opening a page", async (t) => {
  const { config, site } = configuredSite(t, "picks-http", "http");
  const contexts = stubContexts();

  await assert.rejects(() => createThanks(config, contexts).thank({ site, torrentId: "9876" }));
  assert.deepEqual(contexts.opened, [], "the http engine must not reach for a browser page");
});

void test("a Thanks that blows up is counted and timed against its Site", async (t) => {
  const { config, site } = configuredSite(t, "records-both");
  const contexts = stubContexts();

  const erroredBefore = await metricValue("tracker_torrents_errored_total", { site: site.id });
  const timedBefore = await histogramCount("tracker_thank_duration_seconds", { site: site.id });

  await assert.rejects(() => createThanks(config, contexts).thank({ site, torrentId: "9876" }));

  assert.equal(
    (await metricValue("tracker_torrents_errored_total", { site: site.id })) - erroredBefore,
    1,
    "the failure must be counted against the Site it happened on",
  );
  assert.equal(
    (await histogramCount("tracker_thank_duration_seconds", { site: site.id })) - timedBefore,
    1,
    "a Thanks is timed whether it lands or blows up",
  );
});
