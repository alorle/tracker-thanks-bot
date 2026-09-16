import { loadSites, getScanConfig, envVarBase, type SitesMap } from "./config.ts";
import { log } from "./log.ts";
import { closeAll } from "./browser.ts";
import { thank, getThanksEngine } from "./thank.ts";
import { startServer } from "./webhook-server.ts";
import { QBittorrentClient } from "./qbittorrent.ts";
import { scanAllTorrents } from "./scanner.ts";
import { scheduleDaily } from "./scheduler.ts";

function mask(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}

function logConfig(sites: SitesMap): void {
  const siteVars: [string, string][] = [...sites.values()].flatMap((site) => {
    const base = envVarBase(site.id);
    return [
      [`${base}_USERNAME`, process.env[`${base}_USERNAME`] ?? "(not set)"],
      [`${base}_PASSWORD`, mask(process.env[`${base}_PASSWORD`])],
    ];
  });

  const entries: [string, string][] = [
    ["WEBHOOK_PORT", process.env.WEBHOOK_PORT ?? "(not set, default: 3000)"],
    ["WEBHOOK_SECRET", mask(process.env.WEBHOOK_SECRET)],
    ["QBIT_URL", process.env.QBIT_URL ?? "(not set)"],
    ["QBIT_API_KEY", mask(process.env.QBIT_API_KEY)],
    ["QBIT_USERNAME", process.env.QBIT_USERNAME ?? "(not set)"],
    ["QBIT_PASSWORD", mask(process.env.QBIT_PASSWORD)],
    ["SITES_CONFIG_PATH", process.env.SITES_CONFIG_PATH ?? "(not set, using default)"],
    ...siteVars,
    ["CACHE_DIR", process.env.CACHE_DIR ?? "(not set)"],
    ["THANKS_ENGINE", getThanksEngine()],
    ["SCAN_ENABLED", process.env.SCAN_ENABLED ?? "(not set, default: true)"],
    ["SCAN_HOUR", process.env.SCAN_HOUR ?? "(not set, default: 3)"],
    ["SCAN_ON_START", process.env.SCAN_ON_START ?? "(not set, default: false)"],
  ];
  const width = Math.max(...entries.map(([name]) => name.length));

  log("config", "Loaded environment config:");
  for (const [name, value] of entries) {
    log("config", `  ${name.padEnd(width)} = ${value}`);
  }
}

async function runCli(sites: SitesMap, siteKey: string, torrentIds: string[]): Promise<void> {
  const site = sites.get(siteKey);
  if (!site) {
    log("auto-thanks", `Unknown site "${siteKey}". Available: ${[...sites.keys()].join(", ")}`);
    process.exit(1);
  }

  const logPrefix = `auto-thanks:${site.id}`;

  log(logPrefix, `Processing ${torrentIds.length} torrent(s)...`);

  try {
    for (const torrentId of torrentIds) {
      try {
        await thank({ site, torrentId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Login failed")) throw error;
        log(logPrefix, `Error processing torrent ${torrentId}: ${message}`);
      }
    }
  } finally {
    await closeAll();
  }

  log(logPrefix, "Done.");
}

async function main(): Promise<void> {
  const sites = loadSites();
  logConfig(sites);
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    const port = Number(process.env.WEBHOOK_PORT ?? "3000");
    const scanConfig = getScanConfig();
    const qbClient = QBittorrentClient.fromEnv();
    await startServer(sites, port, qbClient);

    if (scanConfig.enabled) {
      scheduleDaily(scanConfig.hour, () => scanAllTorrents(sites, qbClient));
      if (scanConfig.onStart) {
        scanAllTorrents(sites, qbClient).catch((err) =>
          log("scanner", `Initial scan failed: ${err}`),
        );
      }
    }
    return;
  }

  if (command === "scan") {
    const qbClient = QBittorrentClient.fromEnv();
    try {
      await scanAllTorrents(sites, qbClient);
    } finally {
      await closeAll();
    }
    return;
  }

  if (command && sites.has(command) && rest.length > 0) {
    await runCli(sites, command, rest);
    return;
  }

  console.log(`Usage:
  node dist/index.js <site> <id1> <id2> ...   Thank specific torrents
  node dist/index.js serve                    Start webhook server + daily scan
  node dist/index.js scan                     Run scan once and exit

Sites are configured in sites.json (see SITES_CONFIG_PATH).
For each Site id, set <ID>_USERNAME and <ID>_PASSWORD env vars
(uppercase id, with '-' replaced by '_').

Other environment variables:
  QBIT_URL                       qBittorrent WebUI URL
  QBIT_API_KEY                   qBittorrent API key (v5.2.0+, preferred)
  QBIT_USERNAME                  qBittorrent WebUI username (if no API key)
  QBIT_PASSWORD                  qBittorrent WebUI password (if no API key)
  WEBHOOK_PORT                   Webhook server port (default: 3000)
  WEBHOOK_SECRET                 Shared secret required in X-Webhook-Secret header (optional but recommended)
  SITES_CONFIG_PATH              Path to sites.json (default: <repo>/config/sites.json or /app/config/sites.json in Docker)
  CACHE_DIR                      Browser session cache directory
  SCAN_ENABLED                   Enable daily scan (default: true)
  SCAN_HOUR                      Hour to run daily scan, 0-23 (default: 3)
  SCAN_ON_START                  Run scan on startup (default: false)`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auto-thanks] Fatal error: ${message}`);
  process.exit(1);
});
