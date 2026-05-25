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
    contexts.set(siteKey, context);
  }
  return context;
}

export async function getPage(siteKey: string): Promise<Page> {
  const context = await getContext(siteKey);
  return context.pages()[0] ?? (await context.newPage());
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
