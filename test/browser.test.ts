import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A thank that throws (a failed login, a network blip) must not take the Site's
// queue with it: everything grabbed afterwards would then wait on a promise
// that never settles, and the bot would go quiet without a single error.
void test("a failed task does not stall the queue for that Site", async () => {
  const { enqueue } = await import("../src/browser.ts");
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

// Regression: a crashed renderer cannot be revived, so neither a page nor a
// context may be handed out twice once it is gone.
void test("every thank gets a fresh page and a closed context is never reused", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-browser-"));
  const originalCacheDir = process.env.CACHE_DIR;
  process.env.CACHE_DIR = join(tmpDir, "cache");

  const { freshPage, getContext, closeAll } = await import("../src/browser.ts");

  t.after(async () => {
    await closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = originalCacheDir;
  });

  const first = await freshPage("pages-site");
  const second = await freshPage("pages-site");
  assert.notEqual(first, second, "each thank must get its own page");

  const context = await getContext("pages-site");
  assert.equal(context.pages().length, 1, "the pages left by earlier work must be closed");

  await context.close();
  const reopened = await getContext("pages-site");
  assert.notEqual(reopened, context, "a closed context must not be served from the cache");
});
