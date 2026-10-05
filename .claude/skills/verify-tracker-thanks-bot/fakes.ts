#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startFakeTracker } from "../../../test/fake-tracker.ts";
import { startFakeQBittorrent } from "../../../test/fake-qbittorrent.ts";

const runRoot = process.argv[2];
if (!runRoot) {
  console.error("usage: fakes.ts <run-dir>");
  process.exit(2);
}
const scratch = join(runRoot, "run");
const evidence = join(runRoot, "evidence");
mkdirSync(scratch, { recursive: true });
mkdirSync(evidence, { recursive: true });

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const tracker = await startFakeTracker({
  validCredentials: { username: "verify-user", password: "verify-pw" },
  withoutButton: ["102"],
  rejects: ["103"],
});

const torrents = new Map([
  ["a".repeat(40), { name: "Thankable.Movie", comment: `Source: ${tracker.baseUrl}/torrents/101` }],
  ["b".repeat(40), { name: "No.Button.Movie", comment: `Source: ${tracker.baseUrl}/torrents/102` }],
  ["c".repeat(40), { name: "Refused.Movie", comment: `Source: ${tracker.baseUrl}/torrents/103` }],
  [
    "d".repeat(40),
    { name: "Foreign.Movie", comment: "Source: https://unknown.example/torrents/5" },
  ],
]);
const qbit = await startFakeQBittorrent({ torrents });
const webhookPort = await freePort();

writeFileSync(
  join(scratch, "sites.json"),
  JSON.stringify({ sites: [{ id: "verify-site", base_url: tracker.baseUrl }] }),
);
writeFileSync(
  join(scratch, "bot.env"),
  [
    `WEBHOOK_PORT=${webhookPort}`,
    "WEBHOOK_SECRET=verify-secret",
    `QBIT_URL=${qbit.baseUrl}`,
    "QBIT_USERNAME=qbit-user",
    "QBIT_PASSWORD=qbit-pw",
    `SITES_CONFIG_PATH=${join(scratch, "sites.json")}`,
    `CACHE_DIR=${join(scratch, "cache")}`,
    "VERIFY_SITE_USERNAME=verify-user",
    "VERIFY_SITE_PASSWORD=verify-pw",
    "SCAN_ENABLED=false",
    "SCAN_DELAY_MS=0",
    "",
  ].join("\n"),
);
writeFileSync(join(scratch, "fakes.pid"), String(process.pid));

const dumpState = (): void =>
  writeFileSync(
    join(evidence, "fake-state.json"),
    JSON.stringify(
      {
        trackerUrl: tracker.baseUrl,
        qbitUrl: qbit.baseUrl,
        logins: tracker.logins,
        clicks: tracker.clicks,
        trackerRequests: tracker.requests,
        qbitRequests: qbit.requests,
      },
      null,
      2,
    ),
  );
dumpState();
const timer = setInterval(dumpState, 200);

const stop = async (): Promise<void> => {
  clearInterval(timer);
  dumpState();
  await Promise.all([tracker.close(), qbit.close()]);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

console.log(
  `FAKES READY tracker=${tracker.baseUrl} qbit=${qbit.baseUrl} webhook=http://127.0.0.1:${webhookPort}`,
);
