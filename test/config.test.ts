import { test } from "node:test";
import assert from "node:assert/strict";
import { getScanConfig } from "../src/config.ts";

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
