import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScanConfig, loadSites } from "../src/config.ts";

// A mistyped SCAN_HOUR used to reach the scheduler as NaN, which Node turns
// into a 1ms timer: the daily scan then ran back to back forever, hammering
// both qBittorrent and the Site.
void test("an unusable SCAN_HOUR is rejected instead of scheduling a runaway scan", (t) => {
  const original = process.env.SCAN_HOUR;
  t.after(() => {
    if (original === undefined) delete process.env.SCAN_HOUR;
    else process.env.SCAN_HOUR = original;
  });

  for (const value of ["not-a-number", "3.5", "-1", "24"]) {
    process.env.SCAN_HOUR = value;
    assert.throws(() => getScanConfig(), /SCAN_HOUR/, `expected "${value}" to be rejected`);
  }

  process.env.SCAN_HOUR = "0";
  assert.equal(getScanConfig().hour, 0);

  // An unset variable and one left blank in .env both mean "use the default".
  process.env.SCAN_HOUR = "";
  assert.equal(getScanConfig().hour, 3);
  delete process.env.SCAN_HOUR;
  assert.equal(getScanConfig().hour, 3);
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
    assert.throws(() => loadSites(path), expected, `expected ${what} to be refused`);
  }

  assert.throws(() => loadSites(write("{ not json")), /is not valid JSON/);
  assert.throws(() => loadSites(join(tmpDir, "absent.json")), /Sites config not found/);
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

  const originalEnv = { ...process.env };
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  delete process.env.NEEDS_CREDS_USERNAME;
  delete process.env.NEEDS_CREDS_PASSWORD;
  assert.throws(() => loadSites(path), /NEEDS_CREDS_USERNAME, NEEDS_CREDS_PASSWORD/);

  process.env.NEEDS_CREDS_USERNAME = "operator-user";
  assert.throws(() => loadSites(path), /credential env vars: NEEDS_CREDS_PASSWORD/);

  process.env.NEEDS_CREDS_PASSWORD = "operator-pw";
  assert.equal(loadSites(path).size, 1, "both vars set, the Site must load");
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

  const originalEnv = { ...process.env };
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });
  process.env.SPELLED_USERNAME = "operator-user";
  process.env.SPELLED_PASSWORD = "operator-pw";

  assert.equal(loadSites(path).get("spelled")?.baseUrl, "https://tracker.example.com");
});
