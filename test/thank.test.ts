import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config, type Site } from "../src/config.ts";
import { createThanks } from "../src/thank.ts";
import { findThankButton, ThanksRefusedAsInvalidError } from "../src/http-thanks.ts";
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

async function siteOn(
  t: TestContext,
  id: string,
  options: Parameters<typeof startFakeTracker>[0] = {},
) {
  const tracker = await startFakeTracker({
    validCredentials: { username: "operator-user", password: "operator-pw" },
    ...options,
  });
  t.after(() => tracker.close());
  return { ...configuredSite(t, id, tracker.baseUrl), tracker };
}

function refusingSite(t: TestContext, id: string, torrentId: string, refusal?: string) {
  return siteOn(t, id, { livewire: 3, rejects: [torrentId], refusal });
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

void test("Livewire turning down our own payload is an error, not a skip", async (t) => {
  const { config, site } = await refusingSite(
    t,
    "bad-payload",
    "9876",
    "Component payload was altered!",
  );
  const erroredBefore = await metricValue("tracker_torrents_errored_total", { site: site.id });
  const skippedBefore = await metricValue("tracker_torrents_skipped_total", {
    site: site.id,
    reason: "rejected",
  });

  const asked: string[] = [];
  const thanks = createThanks(config, (message) => {
    asked.push(message);
    return Promise.resolve("other");
  });

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
  assert.deepEqual(asked, [], "Livewire's own words are not the Site's, so nothing places them");
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

void test("a torrent page without a thanks button is skipped as such", async (t) => {
  const { config, site, tracker } = await siteOn(t, "no-button", { withoutButton: ["9876"] });

  const outcome = await createThanks(config).thank({ site, torrentId: "9876" });

  assert.deepEqual(outcome, { status: "skipped", reason: "no_button" });
  assert.deepEqual(tracker.clicks, []);
});

void test("redirects are followed up to ten hops to reach the torrent page", async (t) => {
  const { config, site } = await siteOn(t, "ten-hops", { redirects: 10 });

  const outcome = await createThanks(config).thank({ site, torrentId: "9876" });

  assert.equal(outcome.status, "thanked");
});

void test("a Site that never stops redirecting is given up on", async (t) => {
  const { config, site } = await siteOn(t, "endless-hops", { redirects: Infinity });

  await assert.rejects(
    () => createThanks(config).thank({ site, torrentId: "9876" }),
    /Too many redirects/,
  );
});

void test("a restarted bot reuses the session it left on disk", async (t) => {
  const { config, site, tracker } = await siteOn(t, "restarted");

  await createThanks(config).thank({ site, torrentId: "1111" });
  const outcome = await createThanks(config).thank({ site, torrentId: "2222" });

  assert.equal(outcome.status, "thanked");
  assert.equal(tracker.logins.length, 1, "the stored session must spare a second login");
});

void test("a login whose session the Site does not honour is an error", async (t) => {
  const { config, site, tracker } = await siteOn(t, "forgetful", { forgetsSessions: true });

  await assert.rejects(
    () => createThanks(config).thank({ site, torrentId: "9876" }),
    /still redirects to \/login/,
  );
  assert.deepEqual(tracker.clicks, []);
});

void test("a torrent page without a csrf token is an error", async (t) => {
  const { config, site } = await siteOn(t, "no-csrf", { withoutCsrfToken: true });

  await assert.rejects(() => createThanks(config).thank({ site, torrentId: "9876" }), /csrf-token/);
});

type LivewireAnswer = { status: number; headers?: Record<string, string>; body: string };

const success = JSON.stringify({
  components: [{ effects: { dispatches: [{ name: "success", params: { message: "ok" } }] } }],
});

for (const [answer, fails] of [
  [{ status: 500, body: "Server Error" }, /returned 500/],
  [{ status: 400, headers: { Location: "/" }, body: "" }, /returned 400/],
  [{ status: 200, body: "<html>maintenance</html>" }, /non-JSON/],
] as [LivewireAnswer, RegExp][]) {
  void test(`a Livewire answer of ${answer.status} "${answer.body}" is an error`, async (t) => {
    const { config, site } = await siteOn(t, `answers-${answer.status}`, { answer });

    await assert.rejects(() => createThanks(config).thank({ site, torrentId: "9876" }), fails);
  });
}

void test("a Location header on a 200 Livewire answer is not followed", async (t) => {
  const { config, site } = await siteOn(t, "located", {
    answer: { status: 200, headers: { Location: "/" }, body: success },
  });

  const outcome = await createThanks(config).thank({ site, torrentId: "9876" });

  assert.equal(outcome.status, "thanked");
});

void test("a Livewire answer that dispatches nothing is a thanks", async (t) => {
  const { config, site } = await siteOn(t, "silent", {
    answer: { status: 200, body: JSON.stringify({ components: [] }) },
  });

  const outcome = await createThanks(config).thank({ site, torrentId: "9876" });

  assert.equal(outcome.status, "thanked");
});

void test("an error dispatched without a message is still a refusal", async (t) => {
  const { config, site } = await siteOn(t, "wordless", {
    answer: {
      status: 200,
      body: JSON.stringify({ components: [{ effects: { dispatches: [{ name: "error" }] } }] }),
    },
  });

  const asked: string[] = [];
  const outcome = await createThanks(config, (message) => {
    asked.push(message);
    return Promise.resolve("other");
  }).thank({ site, torrentId: "9876" });

  assert.deepEqual(outcome, { status: "skipped", reason: "rejected", message: "unknown error" });
  assert.deepEqual(asked, ["unknown error"]);
});

void test("every outcome is logged naming its torrent, a refusal in the Site's own words", async (t) => {
  const refusal = "Has agotado tus agradecimientos.";
  const { config, site } = await siteOn(t, "logged", {
    livewire: 2,
    withoutButton: ["2"],
    rejects: ["3"],
    refusal,
  });
  const placed = ["quota_exhausted", "not_eligible", "other"] as const;
  let asked = 0;
  const thanks = createThanks(config, () => Promise.resolve(placed[asked++] ?? "other"));
  const logged = t.mock.method(console, "log", () => undefined);

  const lastLine = async (torrentId: string): Promise<string> => {
    await thanks.thank({ site, torrentId });
    return String(logged.mock.calls.at(-1)?.arguments[0]);
  };
  const lines = {
    thanked: await lastLine("1"),
    alreadyThanked: await lastLine("1"),
    noButton: await lastLine("2"),
    quotaExhausted: await lastLine("3"),
    notEligible: await lastLine("3"),
    rejected: await lastLine("3"),
  };
  logged.mock.restore();

  assert.match(lines.thanked, /\b1\b/);
  assert.match(lines.alreadyThanked, /\b1\b/);
  assert.match(lines.noButton, /\b2\b/);
  for (const line of [lines.quotaExhausted, lines.notEligible, lines.rejected]) {
    assert.ok(line.includes(refusal), `the Operator must read why the Site refused: ${line}`);
  }
  const withoutTorrent = Object.values(lines).map((line) => line.replace(/\b[123]\b/g, "#"));
  assert.equal(
    new Set(withoutTorrent).size,
    withoutTorrent.length,
    "each outcome must read differently in the log",
  );
});

const thanksPayload = { memo: { name: "thank-button" }, title: `Bob's <HD> & "co"` };

function escaped(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const snapshot = (value: unknown = thanksPayload): string => `wire:snapshot="${escaped(value)}"`;

void test("the thanks payload is handed back exactly as the page served it", () => {
  const button = findThankButton(`<button ${snapshot()}>Agradecer</button>`);

  assert.equal(button?.snapshot, JSON.stringify(thanksPayload), "the payload is server-signed");
  assert.equal(button?.livewire, 3);
  assert.equal(button?.disabled, false);
});

void test("unreadable and unnamed payloads on the page are passed over", () => {
  const button = findThankButton(
    `<div wire:snapshot="not json"></div><div ${snapshot({ data: {} })}></div>` +
      `<button ${snapshot()}>Agradecer</button>`,
  );

  assert.equal(button?.snapshot, JSON.stringify(thanksPayload));
});

for (const [why, html, disabled] of [
  ["disabled ahead of the payload", `<button disabled ${snapshot()}>Agradecer</button>`, true],
  [
    "disabled behind quoted attributes that hold a >",
    `<button ${snapshot()} x-show="n > 0" title='a > b' disabled>Agradecer</button>`,
    true,
  ],
  [
    "enabled, followed by another button that is disabled",
    `<button ${snapshot()}>Agradecer</button><button disabled>Favorito</button>`,
    false,
  ],
] as const) {
  void test(`a thanks button ${why} reads as ${disabled ? "disabled" : "enabled"}`, () => {
    assert.equal(findThankButton(html)?.disabled, disabled);
  });
}
