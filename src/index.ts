import { loadSites, getSiteCredentials, getScanConfig, envVarBase, type SitesMap } from "./config.js";
import { log } from "./log.js";
import { getPage, closeAll } from "./browser.js";
import { thankTorrent } from "./thanks.js";
import { startServer } from "./webhook-server.js";
import { QBittorrentClient } from "./qbittorrent.js";
import { scanAllTorrents } from "./scanner.js";
import { scheduleDaily } from "./scheduler.js";

function mask(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}

function logConfig(sites: SitesMap): void {
  log("config", "Loaded environment config:");
  log(
    "config",
    `  WEBHOOK_PORT     = ${process.env.WEBHOOK_PORT ?? "(not set, default: 3000)"}`,
  );
  log(
    "config",
    `  WEBHOOK_SECRET   = ${mask(process.env.WEBHOOK_SECRET)}`,
  );
  log("config", `  QBIT_URL         = ${process.env.QBIT_URL ?? "(not set)"}`);
  log("config", `  QBIT_API_KEY     = ${mask(process.env.QBIT_API_KEY)}`);
  log(
    "config",
    `  QBIT_USERNAME    = ${process.env.QBIT_USERNAME ?? "(not set)"}`,
  );
  log("config", `  QBIT_PASSWORD    = ${mask(process.env.QBIT_PASSWORD)}`);
  log(
    "config",
    `  SITES_CONFIG_PATH = ${process.env.SITES_CONFIG_PATH ?? "(not set, using default)"}`,
  );
  for (const site of sites.values()) {
    const base = envVarBase(site.id);
    log(
      "config",
      `  ${base}_USERNAME   = ${process.env[`${base}_USERNAME`] ?? "(not set)"}`,
    );
    log(
      "config",
      `  ${base}_PASSWORD   = ${mask(process.env[`${base}_PASSWORD`])}`,
    );
  }
  log("config", `  CACHE_DIR        = ${process.env.CACHE_DIR ?? "(not set)"}`);
  log(
    "config",
    `  SCAN_ENABLED     = ${process.env.SCAN_ENABLED ?? "(not set, default: true)"}`,
  );
  log(
    "config",
    `  SCAN_HOUR        = ${process.env.SCAN_HOUR ?? "(not set, default: 3)"}`,
  );
  log(
    "config",
    `  SCAN_ON_START    = ${process.env.SCAN_ON_START ?? "(not set, default: false)"}`,
  );
}

async function runCli(sites: SitesMap, siteKey: string, torrentIds: string[]): Promise<void> {
  const site = sites.get(siteKey);
  if (!site) {
    log(
      "auto-thanks",
      `Unknown site "${siteKey}". Available: ${[...sites.keys()].join(", ")}`,
    );
    process.exit(1);
  }

  const { username, password } = getSiteCredentials(site);
  const logPrefix = `auto-thanks:${site.id}`;

  log(logPrefix, `Processing ${torrentIds.length} torrent(s)...`);

  const page = await getPage(siteKey);
  try {
    for (const torrentId of torrentIds) {
      try {
        await thankTorrent(
          page,
          torrentId,
          username,
          password,
          site,
          logPrefix,
        );
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
    await startServer(sites, port);

    const qbClient = QBittorrentClient.fromEnv();
    const scanConfig = getScanConfig();
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

  console.log("Usage:");
  console.log(
    "  node dist/index.js <site> <id1> <id2> ...   Thank specific torrents",
  );
  console.log(
    "  node dist/index.js serve                    Start webhook server + daily scan",
  );
  console.log(
    "  node dist/index.js scan                     Run scan once and exit",
  );
  console.log(
    "\nSites are configured in sites.json (see SITES_CONFIG_PATH).",
  );
  console.log(
    "For each Site id, set <ID>_USERNAME and <ID>_PASSWORD env vars",
  );
  console.log(
    "(uppercase id, with '-' replaced by '_').",
  );
  console.log("\nOther environment variables:");
  console.log("  QBIT_URL                       qBittorrent WebUI URL");
  console.log(
    "  QBIT_API_KEY                   qBittorrent API key (v5.2.0+, preferred)",
  );
  console.log(
    "  QBIT_USERNAME                  qBittorrent WebUI username (if no API key)",
  );
  console.log(
    "  QBIT_PASSWORD                  qBittorrent WebUI password (if no API key)",
  );
  console.log(
    "  WEBHOOK_PORT                   Webhook server port (default: 3000)",
  );
  console.log(
    "  WEBHOOK_SECRET                 Shared secret required in X-Webhook-Secret header (optional but recommended)",
  );
  console.log(
    "  SITES_CONFIG_PATH              Path to sites.json (default: <repo>/config/sites.json or /app/config/sites.json in Docker)",
  );
  console.log(
    "  CACHE_DIR                      Browser session cache directory",
  );
  console.log(
    "  SCAN_ENABLED                   Enable daily scan (default: true)",
  );
  console.log(
    "  SCAN_HOUR                      Hour to run daily scan, 0-23 (default: 3)",
  );
  console.log(
    "  SCAN_ON_START                  Run scan on startup (default: false)",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auto-thanks] Fatal error: ${message}`);
  process.exit(1);
});
