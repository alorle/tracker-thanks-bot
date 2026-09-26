import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueue } from "../src/queue.ts";

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
