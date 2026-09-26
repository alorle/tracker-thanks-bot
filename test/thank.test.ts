import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config, type Site } from "../src/config.ts";
import { createThanks, ThanksRefusedAsInvalidError } from "../src/thank.ts";
import { startFakeTracker } from "./fake-tracker.ts";
import { histogramCount, metricValue } from "./metric-probe.ts";

function configuredSite(
  t: TestContext,
  id: string,
  baseUrl = "http://127.0.0.1:1",
): { config: Config; site: Site } {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-seam-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const path = join(tmpDir, "sites.json");
  writeFileSync(path, JSON.stringify({ sites: [{ id, base_url: baseUrl }] }));

  const base = id.toUpperCase().replaceAll("-", "_");
  const config = loadConfig({
    SITES_CONFIG_PATH: path,
    CACHE_DIR: join(tmpDir, "cache"),
    [`${base}_USERNAME`]: "operator-user",
    [`${base}_PASSWORD`]: "operator-pw",
  });

  const site = config.sites.get(id);
  assert.ok(site, "expected the configured Site");
  return { config, site };
}

void test("a Thanks that blows up is counted and timed against its Site", async (t) => {
  const { config, site } = configuredSite(t, "records-both");
  const erroredBefore = await metricValue("tracker_torrents_errored_total", { site: site.id });
  const timedBefore = await histogramCount("tracker_thank_duration_seconds", { site: site.id });

  await assert.rejects(() => createThanks(config).thank({ site, torrentId: "9876" }));

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

async function refusingSite(t: TestContext, id: string, torrentId: string) {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
    livewire: 3,
    rejects: [torrentId],
  });
  t.after(() => tracker.close());
  return configuredSite(t, id, tracker.baseUrl);
}

void test("a refusal the classifier places is recorded under that reason", async (t) => {
  const { config, site } = await refusingSite(t, "out-of-thanks", "9876");
  const before = await metricValue("tracker_torrents_skipped_total", {
    site: site.id,
    reason: "quota_exhausted",
  });

  const thanks = createThanks(config, () => Promise.resolve("quota_exhausted"));
  const outcome = await thanks.thank({ site, torrentId: "9876" });

  assert.equal(outcome.status, "skipped");
  assert.equal(
    outcome.status === "skipped" ? outcome.reason : null,
    "quota_exhausted",
    "the seam must hand the caller the placed reason, not the bare refusal",
  );
  assert.equal(
    (await metricValue("tracker_torrents_skipped_total", {
      site: site.id,
      reason: "quota_exhausted",
    })) - before,
    1,
    "the metric must carry the reason the Operator would act on",
  );
});

void test("a refusal aimed at our own payload is an error, not a skip", async (t) => {
  const { config, site } = await refusingSite(t, "bad-payload", "9876");
  const erroredBefore = await metricValue("tracker_torrents_errored_total", { site: site.id });
  const skippedBefore = await metricValue("tracker_torrents_skipped_total", {
    site: site.id,
    reason: "rejected",
  });

  const thanks = createThanks(config, () => Promise.resolve("protocol_error"));

  await assert.rejects(
    () => thanks.thank({ site, torrentId: "9876" }),
    ThanksRefusedAsInvalidError,
    "a malformed call of ours must not be filed away as the Site saying no",
  );
  assert.equal(
    (await metricValue("tracker_torrents_errored_total", { site: site.id })) - erroredBefore,
    1,
  );
  assert.equal(
    (await metricValue("tracker_torrents_skipped_total", {
      site: site.id,
      reason: "rejected",
    })) - skippedBefore,
    0,
    "it must not also be counted as a skip",
  );
});

void test("only a refusal reaches the classifier, and with the Site's own words", async (t) => {
  const { config, site } = await refusingSite(t, "asks-once", "9876");

  const asked: string[] = [];
  const thanks = createThanks(config, (message) => {
    asked.push(message);
    return Promise.resolve("not_eligible");
  });

  const refused = await thanks.thank({ site, torrentId: "9876" });
  const landed = await thanks.thank({ site, torrentId: "5555" });

  assert.equal(refused.status, "skipped");
  assert.equal(landed.status, "thanked", "the Site accepts any torrent it was not told to refuse");
  assert.deepEqual(
    asked,
    ["No puedes agradecer este torrent."],
    "a Thanks that landed must never be sent off to be placed, and a refusal goes verbatim",
  );
});
