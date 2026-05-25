import { log } from "./log.js";

const PREFIX = "scheduler";

export function scheduleDaily(hour: number, task: () => Promise<void>): void {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    const ms = next.getTime() - now.getTime();
    const hoursUntil = (ms / 3_600_000).toFixed(1);
    log(PREFIX, `Next scan scheduled at ${next.toISOString()} (in ${hoursUntil}h)`);

    setTimeout(() => {
      log(PREFIX, "Running scheduled scan...");
      task()
        .then(() => log(PREFIX, "Scheduled scan finished."))
        .catch((err) => log(PREFIX, `Scheduled scan failed: ${err}`))
        .finally(scheduleNext);
    }, ms);
  };

  scheduleNext();
}
