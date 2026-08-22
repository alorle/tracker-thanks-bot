import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

const contexts = new Map<string, BrowserContext>();
const queues = new Map<string, Promise<void>>();

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? join(import.meta.dirname, "..", ".cache");
}

export async function getContext(siteKey: string): Promise<BrowserContext> {
  let context = contexts.get(siteKey);
  if (!context) {
    const sessionsDir = join(getCacheDir(), "sessions", siteKey);
    context = await chromium.launchPersistentContext(sessionsDir, { headless: true });
    // Never keep a dead context cached: if the browser process goes away, the
    // next getContext must launch a new one instead of handing out a corpse.
    context.once("close", () => contexts.delete(siteKey));
    contexts.set(siteKey, context);
  }
  return context;
}

/**
 * Open a page for a site, discarding whatever page earlier work left behind.
 *
 * Never reuse a page across torrents. A crashed page cannot be recovered in
 * Playwright, and the way it crashes here is the kernel OOM-killing its
 * renderer mid-scan; a cached one then fails every later navigation with
 * "Page crashed" until the process is restarted. Reusing one also lets
 * renderer memory grow across hundreds of navigations, which is what pushes
 * the container into that OOM to begin with. The session lives in the
 * persistent context, not in the page, so a fresh page is still logged in.
 */
export async function freshPage(siteKey: string): Promise<Page> {
  const context = await getContext(siteKey);
  // A crashed page may refuse to close; that must not block its replacement.
  await Promise.all(context.pages().map((page) => page.close().catch(() => {})));
  return context.newPage();
}

/**
 * Enqueue work for a site to prevent concurrent Playwright operations.
 * Returns a promise that resolves when the enqueued work completes.
 */
export function enqueue(siteKey: string, work: () => Promise<void>): Promise<void> {
  const prev = queues.get(siteKey) ?? Promise.resolve();
  const next = prev.then(work, () => work());
  queues.set(siteKey, next);
  return next;
}

/**
 * Wait for every per-site queue to drain. Resolves once all currently-enqueued
 * work has finished (success or failure). Does not prevent new enqueues — the
 * caller must stop accepting new work first.
 */
export async function drainAll(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}

export async function closeAll(): Promise<void> {
  for (const [key, context] of contexts) {
    await context.close();
    contexts.delete(key);
  }
}
