import { registry } from "../src/metrics.ts";

/**
 * Read one metric sample straight from the registry.
 *
 * Counters accumulate for the lifetime of the test process, so a test compares
 * a value taken before its action with the one taken after, never the absolute.
 */
export async function metricValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((entry) => entry.name === name);
  const values = (metric?.values ?? []) as { labels: Record<string, unknown>; value: number }[];
  const sample = values.find((candidate) =>
    Object.entries(labels).every(([key, value]) => String(candidate.labels[key]) === value),
  );
  return sample ? sample.value : 0;
}
