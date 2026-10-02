import { test } from "node:test";
import assert from "node:assert/strict";
import { drainAll, enqueue } from "../src/queue.ts";

// A thank that throws (a failed login, a network blip) must not take the Site's
// queue with it: everything grabbed afterwards would then wait on a promise
// that never settles, and the bot would go quiet without a single error.
void test("a failed task does not stall the queue for that Site", async () => {
  const ran: string[] = [];

  await assert.rejects(
    () =>
      enqueue("queue-site", async () => {
        ran.push("failing");
        await Promise.resolve();
        throw new Error("thank blew up");
      }),
    /thank blew up/,
  );

  await enqueue("queue-site", async () => {
    ran.push("next");
    await Promise.resolve();
  });

  assert.deepEqual(ran, ["failing", "next"], "the task after a failure must still run");
});

void test("a Site's tasks run one after another, not side by side", async () => {
  const events: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  const first = enqueue("serial-site", async () => {
    events.push("first started");
    await held;
    events.push("first finished");
  });
  const second = enqueue("serial-site", async () => {
    events.push("second started");
    await Promise.resolve();
  });

  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first started", "first finished", "second started"]);
});

void test("draining waits for the work still in the queue", async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let drained = false;

  void enqueue("drain-site", () => held);
  const draining = drainAll().then(() => (drained = true));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "draining must not resolve while queued work is still running");
  release();
  await draining;
});
