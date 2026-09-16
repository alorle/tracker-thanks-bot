import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSites } from "../src/config.ts";

function configEnv(t: TestContext): NodeJS.ProcessEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-config-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  const path = join(tmpDir, "sites.json");
  writeFileSync(
    path,
    JSON.stringify({ sites: [{ id: "any", base_url: "https://a.example.com" }] }),
  );
  return { SITES_CONFIG_PATH: path, ANY_USERNAME: "operator-user", ANY_PASSWORD: "operator-pw" };
}

// A mistyped SCAN_HOUR used to reach the scheduler as NaN, which Node turns
// into a 1ms timer: the daily scan then ran back to back forever, hammering
// both qBittorrent and the Site.
void test("an unusable SCAN_HOUR is rejected instead of scheduling a runaway scan", (t) => {
  const env = configEnv(t);

  for (const value of ["not-a-number", "3.5", "-1", "24"]) {
    assert.throws(
      () => loadConfig({ ...env, SCAN_HOUR: value }),
      /SCAN_HOUR/,
      `expected "${value}" to be rejected`,
    );
  }

  // The accepted edges matter as much as the rejected ones: a validation that
  // slipped one value would still pass a test that only tried 24 and -1.
  assert.equal(loadConfig({ ...env, SCAN_HOUR: "0" }).scan.hour, 0);
  assert.equal(loadConfig({ ...env, SCAN_HOUR: "23" }).scan.hour, 23);

  // An unset variable and one left blank in .env both mean "use the default".
  assert.equal(loadConfig({ ...env, SCAN_HOUR: "" }).scan.hour, 3);
  assert.equal(loadConfig(env).scan.hour, 3);
});

// sites.json is hand-written by the Operator, and an id is not just a label:
// it is the cache directory, the metrics label and the credential env var
// prefix. Every mistake below would otherwise surface much later as a Site
// that silently never gets thanked.
void test("a sites.json the Operator got wrong is refused at load time", (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-config-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  let written = 0;
  const write = (contents: string): string => {
    const path = join(tmpDir, `sites-${written++}.json`);
    writeFileSync(path, contents);
    return path;
  };

  const refused: [string, unknown, RegExp][] = [
    ["no sites key", {}, /non-empty "sites" array/],
    ["an empty sites array", { sites: [] }, /non-empty "sites" array/],
    [
      "an id that is not a string",
      { sites: [{ id: 7, base_url: "https://a.example.com" }] },
      /missing required string field "id"/,
    ],
    [
      "an id with uppercase in it",
      { sites: [{ id: "Site", base_url: "https://a.example.com" }] },
      /Site id "Site" is invalid/,
    ],
    [
      "an id past the 32 character limit",
      { sites: [{ id: "a".repeat(33), base_url: "https://a.example.com" }] },
      /is invalid/,
    ],
    [
      "an id reserved for a subcommand",
      { sites: [{ id: "scan", base_url: "https://a.example.com" }] },
      /is reserved/,
    ],
    [
      "the same id twice",
      {
        sites: [
          { id: "dup", base_url: "https://a.example.com" },
          { id: "dup", base_url: "https://b.example.com" },
        ],
      },
      /Duplicate site id "dup"/,
    ],
    [
      "two ids for one Site",
      {
        sites: [
          { id: "one", base_url: "https://a.example.com" },
          { id: "two", base_url: "https://a.example.com/" },
        ],
      },
      /share the same normalized base_url/,
    ],
    [
      "a base_url that is not a URL",
      { sites: [{ id: "broken", base_url: "not a url" }] },
      /is not a valid URL/,
    ],
    [
      "a missing base_url",
      { sites: [{ id: "broken" }] },
      /missing required string field "base_url"/,
    ],
    [
      "an empty login_button_selector",
      { sites: [{ id: "broken", base_url: "https://a.example.com", login_button_selector: "" }] },
      /must be a non-empty string/,
    ],
  ];

  for (const [what, contents, expected] of refused) {
    const path = write(JSON.stringify(contents));
    assert.throws(() => loadSites(path, {}), expected, `expected ${what} to be refused`);
  }

  assert.throws(() => loadSites(write("{ not json"), {}), /is not valid JSON/);
  assert.throws(() => loadSites(join(tmpDir, "absent.json"), {}), /Sites config not found/);
});

// Credentials are looked up from env vars derived from the id, so a Site whose
// vars are missing can never be thanked. Saying so at startup beats discovering
// it on the first grab of the night.
void test("a Site whose credential env vars are missing is refused", (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-config-"));
  const path = join(tmpDir, "sites.json");
  writeFileSync(
    path,
    JSON.stringify({ sites: [{ id: "needs-creds", base_url: "https://tracker.example.com" }] }),
  );

  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  assert.throws(() => loadSites(path, {}), /NEEDS_CREDS_USERNAME, NEEDS_CREDS_PASSWORD/);

  assert.throws(
    () => loadSites(path, { NEEDS_CREDS_USERNAME: "operator-user" }),
    /credential env vars: NEEDS_CREDS_PASSWORD/,
  );

  const site = loadSites(path, {
    NEEDS_CREDS_USERNAME: "operator-user",
    NEEDS_CREDS_PASSWORD: "operator-pw",
  }).get("needs-creds");
  assert.equal(site?.username, "operator-user", "the loaded Site must carry its credentials");
  assert.equal(site?.password, "operator-pw");
});

// The comment in qBittorrent is matched against base_url as a literal prefix,
// so a trailing slash or a capitalised host in sites.json would stop every
// torrent on that Site from matching.
void test("base_url is normalized so comment matching is not thrown off by its spelling", (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-config-"));
  const path = join(tmpDir, "sites.json");
  writeFileSync(
    path,
    JSON.stringify({ sites: [{ id: "spelled", base_url: "https://Tracker.Example.com/" }] }),
  );

  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const env = { SPELLED_USERNAME: "operator-user", SPELLED_PASSWORD: "operator-pw" };
  assert.equal(loadSites(path, env).get("spelled")?.baseUrl, "https://tracker.example.com");
});

// SCAN_DELAY_MS paces the scan against the Site. Zero is a legitimate setting
// (an Operator who accepts the risk), so the validation must accept it while
// still refusing what would reach `sleep` as NaN or a negative delay.
void test("SCAN_DELAY_MS accepts zero and refuses what would break the pacing", (t) => {
  const env = configEnv(t);

  for (const value of ["not-a-number", "1.5", "-1"]) {
    assert.throws(
      () => loadConfig({ ...env, SCAN_DELAY_MS: value }),
      /SCAN_DELAY_MS/,
      `expected "${value}" to be rejected`,
    );
  }

  assert.equal(loadConfig({ ...env, SCAN_DELAY_MS: "0" }).scan.delayMs, 0);
  assert.equal(loadConfig({ ...env, SCAN_DELAY_MS: "" }).scan.delayMs, 1000);
  assert.equal(loadConfig(env).scan.delayMs, 1000);
});

void test("an unusable WEBHOOK_PORT is rejected instead of opening a random one", (t) => {
  const env = configEnv(t);

  for (const value of ["not-a-number", "8080.5", "0", "-1", "65536"]) {
    assert.throws(
      () => loadConfig({ ...env, WEBHOOK_PORT: value }),
      /WEBHOOK_PORT/,
      `expected "${value}" to be rejected`,
    );
  }

  assert.equal(loadConfig({ ...env, WEBHOOK_PORT: "1" }).webhook.port, 1);
  assert.equal(loadConfig({ ...env, WEBHOOK_PORT: "65535" }).webhook.port, 65535);
  assert.equal(loadConfig({ ...env, WEBHOOK_PORT: "" }).webhook.port, 3000);
  assert.equal(loadConfig(env).webhook.port, 3000);
});

// Both switches are opt-out/opt-in by exact word: anything else keeps the
// default, so that a typo cannot silently disable the nightly scan.
void test("the scan switches read one exact word each", (t) => {
  const env = configEnv(t);

  assert.equal(loadConfig(env).scan.enabled, true, "the daily scan is on unless turned off");
  assert.equal(loadConfig(env).scan.onStart, false, "a scan on startup is opt-in");

  assert.equal(loadConfig({ ...env, SCAN_ENABLED: "false" }).scan.enabled, false);
  assert.equal(
    loadConfig({ ...env, SCAN_ENABLED: "no" }).scan.enabled,
    true,
    'only the word "false" turns the scan off',
  );

  assert.equal(loadConfig({ ...env, SCAN_ON_START: "true" }).scan.onStart, true);
  assert.equal(
    loadConfig({ ...env, SCAN_ON_START: "1" }).scan.onStart,
    false,
    'only the word "true" scans on startup',
  );
});

// 32 characters is the documented limit, so it has to load; 33 is refused above.
void test("an id right at the length limit still loads", (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-config-"));
  const id = "a".repeat(32);
  const path = join(tmpDir, "sites.json");
  writeFileSync(path, JSON.stringify({ sites: [{ id, base_url: "https://long.example.com" }] }));

  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const env = {
    [`${id.toUpperCase()}_USERNAME`]: "operator-user",
    [`${id.toUpperCase()}_PASSWORD`]: "operator-pw",
  };
  assert.equal(loadSites(path, env).get(id)?.id, id);
});
