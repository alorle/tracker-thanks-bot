const queues = new Map<string, Promise<unknown>>();

/**
 * Enqueue work for a site so its Thanks run one at a time.
 * Returns a promise that resolves when the enqueued work completes.
 */
export function enqueue<T>(siteKey: string, work: () => Promise<T>): Promise<T> {
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
