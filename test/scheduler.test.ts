import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleDaily } from "../src/scheduler.ts";

const HOUR_MS = 3_600_000;

/** Let the `.finally(scheduleNext)` chain settle; only the timers are faked. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

void test("a scan due later today is scheduled for today", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2026, 8, 15, 1, 0, 0) });
  let runs = 0;

  scheduleDaily(3, async () => {
    runs++;
    await Promise.resolve();
  });

  t.mock.timers.tick(2 * HOUR_MS - 1);
  assert.equal(runs, 0, "nothing may run before the configured hour");
  t.mock.timers.tick(1);
  assert.equal(runs, 1, "the scan must run at 03:00 the same day");
});

void test("a scan whose hour already passed today waits for tomorrow", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2026, 8, 15, 10, 0, 0) });
  let runs = 0;

  scheduleDaily(3, async () => {
    runs++;
    await Promise.resolve();
  });

  t.mock.timers.tick(17 * HOUR_MS - 1);
  assert.equal(runs, 0, "17 hours short of tomorrow's 03:00 nothing may run");
  t.mock.timers.tick(1);
  assert.equal(runs, 1);
});

// Starting exactly on the hour must not schedule a zero-delay timer: that is
// the runaway scan the SCAN_HOUR validation also guards against.
void test("starting exactly on the configured hour waits a full day", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2026, 8, 15, 3, 0, 0) });
  let runs = 0;

  scheduleDaily(3, async () => {
    runs++;
    await Promise.resolve();
  });

  t.mock.timers.tick(1);
  assert.equal(runs, 0, "a scan must not fire immediately at the boundary");
  t.mock.timers.tick(24 * HOUR_MS - 1);
  assert.equal(runs, 1, "it belongs to the next day instead");
});

void test("the scan reschedules itself, and a failing one does not stop the series", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2026, 8, 15, 1, 0, 0) });
  let runs = 0;

  scheduleDaily(3, async () => {
    runs++;
    await Promise.resolve();
    throw new Error("scan blew up");
  });

  t.mock.timers.tick(2 * HOUR_MS);
  assert.equal(runs, 1);

  await flush();
  t.mock.timers.tick(24 * HOUR_MS);
  assert.equal(runs, 2, "the next day must be scheduled even after a failure");
});
