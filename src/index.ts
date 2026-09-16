import { loadConfig, envVarBase, type Config, type SitesMap } from "./config.ts";
import { log } from "./log.ts";
import { createThanks, type Thanks } from "./thank.ts";
import { startServer } from "./webhook-server.ts";
import { QBittorrentClient } from "./qbittorrent.ts";
import { scanAllTorrents } from "./scanner.ts";
import { scheduleDaily } from "./scheduler.ts";

function mask(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}

function logConfig(config: Config): void {
  const siteVars: [string, string][] = [...config.sites.values()].flatMap((site) => {
    const base = envVarBase(site.id);
    return [
      [`${base}_USERNAME`, site.username],
      [`${base}_PASSWORD`, mask(site.password)],
    ];
  });

  const qbit = config.qbittorrent;
  const credentials = qbit?.credentials;
  const entries: [string, string][] = [
    ["WEBHOOK_PORT", String(config.webhook.port)],
    ["WEBHOOK_SECRET", mask(config.webhook.secret ?? undefined)],
    ["QBIT_URL", qbit?.baseUrl ?? "(not set)"],
    ["QBIT_API_KEY", mask(credentials?.mode === "apikey" ? credentials.apiKey : undefined)],
    ["QBIT_USERNAME", credentials?.mode === "cookie" ? credentials.username : "(not set)"],
    ["QBIT_PASSWORD", mask(credentials?.mode === "cookie" ? credentials.password : undefined)],
    ["SITES_CONFIG_PATH", config.sitesPath],
    ...siteVars,
    ["CACHE_DIR", config.cacheDir],
    ["THANKS_ENGINE", config.thanksEngine],
    ["SCAN_ENABLED", String(config.scan.enabled)],
    ["SCAN_HOUR", String(config.scan.hour)],
    ["SCAN_ON_START", String(config.scan.onStart)],
  ];
  const width = Math.max(...entries.map(([name]) => name.length));

  log("config", "Loaded environment config:");
  for (const [name, value] of entries) {
    log("config", `  ${name.padEnd(width)} = ${value}`);
  }
}

async function runCli(
  sites: SitesMap,
  thanks: Thanks,
  siteKey: string,
  torrentIds: string[],
): Promise<void> {
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
        await thanks.thank({ site, torrentId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Login failed")) throw error;
        log(logPrefix, `Error processing torrent ${torrentId}: ${message}`);
      }
    }
  } finally {
    await thanks.closeAll();
  }

  log(logPrefix, "Done.");
}

function qbittorrentClient(config: Config): QBittorrentClient {
  if (!config.qbittorrent) {
    throw new Error("Required environment variable QBIT_URL is not set.");
  }
  return new QBittorrentClient(config.qbittorrent);
}

async function main(): Promise<void> {
  const config = loadConfig();
  logConfig(config);
  const { sites, scan } = config;
  const thanks = createThanks(config);
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    const qbClient = qbittorrentClient(config);
    await startServer(sites, config.webhook, qbClient, thanks);

    if (scan.enabled) {
      scheduleDaily(scan.hour, () => scanAllTorrents(sites, qbClient, thanks, scan.delayMs));
      if (scan.onStart) {
        scanAllTorrents(sites, qbClient, thanks, scan.delayMs).catch((err) =>
          log("scanner", `Initial scan failed: ${err}`),
        );
      }
    }
    return;
  }

  if (command === "scan") {
    const qbClient = qbittorrentClient(config);
    try {
      await scanAllTorrents(sites, qbClient, thanks, scan.delayMs);
    } finally {
      await thanks.closeAll();
    }
    return;
  }

  if (command && sites.has(command) && rest.length > 0) {
    await runCli(sites, thanks, command, rest);
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
