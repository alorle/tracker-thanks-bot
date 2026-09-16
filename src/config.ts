import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import type { QBittorrentConfig } from "./qbittorrent.ts";

export type Site = {
  id: string;
  baseUrl: string;
  loginButtonSelector: string;
  username: string;
  password: string;
};

export type SitesMap = Map<string, Site>;

type SiteSettings = Omit<Site, "username" | "password">;

export type ThanksEngine = "browser" | "http";

export type Config = {
  sitesPath: string;
  cacheDir: string;
  thanksEngine: ThanksEngine;
  sites: SitesMap;
  qbittorrent: QBittorrentConfig | null;
  webhook: { port: number; secret: string | null };
  scan: { enabled: boolean; hour: number; onStart: boolean; delayMs: number };
};

const ID_REGEX = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set([
  "serve",
  "scan",
  "help",
  "version",
  "init",
  "list",
  "add",
  "remove",
  "login",
  "test",
]);
const DEFAULT_LOGIN_BUTTON_SELECTOR = 'button[type="submit"]';

type RawSiteEntry = {
  id?: unknown;
  base_url?: unknown;
  login_button_selector?: unknown;
};

type RawSitesFile = {
  sites?: unknown;
};

function fail(message: string): never {
  throw new Error(message);
}

export function envVarBase(id: string): string {
  return id.toUpperCase().replaceAll("-", "_");
}

function normalizeBaseUrl(raw: string, id: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`Site "${id}" base_url is not a valid URL: "${raw}".`);
  }
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function sitesConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.SITES_CONFIG_PATH) return env.SITES_CONFIG_PATH;
  return join(import.meta.dirname, "..", "config", "sites.json");
}

export function loadSites(path: string, env: NodeJS.ProcessEnv): SitesMap {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fail(
        `Sites config not found at "${path}". Create it with at least one site, e.g.: ` +
          `{"sites":[{"id":"example","base_url":"https://tracker.example.com"}]}`,
      );
    }
    throw err;
  }

  let parsed: RawSitesFile;
  try {
    parsed = JSON.parse(raw) as RawSitesFile;
  } catch (err) {
    fail(`Sites config at "${path}" is not valid JSON: ${(err as Error).message}.`);
  }

  if (!Array.isArray(parsed.sites) || parsed.sites.length === 0) {
    fail(`Sites config at "${path}" must contain a non-empty "sites" array.`);
  }

  const settings = new Map<string, SiteSettings>();
  const seenBaseUrls = new Map<string, string>();

  for (const entry of parsed.sites as RawSiteEntry[]) {
    if (typeof entry.id !== "string") {
      fail(`Sites config at "${path}" has an entry missing required string field "id".`);
    }
    const id = entry.id;
    if (!ID_REGEX.test(id)) {
      fail(
        `Site id "${id}" is invalid: must match /^[a-z][a-z0-9-]{0,31}$/ (lowercase, starts with letter, max 32 chars).`,
      );
    }
    if (RESERVED_IDS.has(id)) {
      fail(`Site id "${id}" is reserved (${[...RESERVED_IDS].join(", ")}).`);
    }
    if (settings.has(id)) {
      fail(`Duplicate site id "${id}" in ${path}.`);
    }

    if (typeof entry.base_url !== "string") {
      fail(`Site "${id}" missing required string field "base_url".`);
    }
    const baseUrl = normalizeBaseUrl(entry.base_url, id);

    const existing = seenBaseUrls.get(baseUrl);
    if (existing) {
      fail(`Sites "${existing}" and "${id}" share the same normalized base_url "${baseUrl}".`);
    }
    seenBaseUrls.set(baseUrl, id);

    const loginButtonSelector =
      entry.login_button_selector === undefined
        ? DEFAULT_LOGIN_BUTTON_SELECTOR
        : entry.login_button_selector;
    if (typeof loginButtonSelector !== "string" || loginButtonSelector.length === 0) {
      fail(`Site "${id}" field "login_button_selector" must be a non-empty string.`);
    }

    settings.set(id, { id, baseUrl, loginButtonSelector });
  }

  const missing: string[] = [];
  const sites: SitesMap = new Map();
  for (const [id, site] of settings) {
    const base = envVarBase(id);
    const username = env[`${base}_USERNAME`];
    const password = env[`${base}_PASSWORD`];
    if (!username) missing.push(`${base}_USERNAME`);
    if (!password) missing.push(`${base}_PASSWORD`);
    if (username && password) sites.set(id, { ...site, username, password });
  }
  if (missing.length > 0) {
    fail(`Missing required credential env vars: ${missing.join(", ")}.`);
  }

  return sites;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function cacheDir(env: NodeJS.ProcessEnv): string {
  return env.CACHE_DIR ?? join(import.meta.dirname, "..", ".cache");
}

/**
 * Which engine performs the Thanks.
 *
 * "browser" drives Playwright (the original path); "http" talks to the Engine's
 * Livewire endpoint directly, which needs no renderer and so cannot be
 * OOM-killed. The flag exists so the two can be swapped without a redeploy of
 * a different image.
 */
function thanksEngine(env: NodeJS.ProcessEnv): ThanksEngine {
  return env.THANKS_ENGINE === "http" ? "http" : "browser";
}

function qbittorrentConfig(env: NodeJS.ProcessEnv): QBittorrentConfig | null {
  const baseUrl = env.QBIT_URL;
  if (!baseUrl) return null;

  const apiKey = env.QBIT_API_KEY;
  if (apiKey) {
    log("qbittorrent", "Using API key authentication (v5.2.0+).");
    return { baseUrl, credentials: { mode: "apikey", apiKey } };
  }

  return {
    baseUrl,
    credentials: {
      mode: "cookie",
      username: requiredEnv(env, "QBIT_USERNAME"),
      password: requiredEnv(env, "QBIT_PASSWORD"),
    },
  };
}

function webhookConfig(env: NodeJS.ProcessEnv): Config["webhook"] {
  const rawPort = env.WEBHOOK_PORT || "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`WEBHOOK_PORT must be an integer between 1 and 65535, got "${rawPort}".`);
  }

  return { port, secret: env.WEBHOOK_SECRET ?? null };
}

function scanConfig(env: NodeJS.ProcessEnv): Config["scan"] {
  const rawHour = env.SCAN_HOUR || "3";
  const hour = Number(rawHour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    fail(`SCAN_HOUR must be an integer between 0 and 23, got "${rawHour}".`);
  }

  const rawDelay = env.SCAN_DELAY_MS || "1000";
  const delayMs = Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    fail(`SCAN_DELAY_MS must be a non-negative integer, got "${rawDelay}".`);
  }

  return {
    enabled: env.SCAN_ENABLED !== "false",
    hour,
    onStart: env.SCAN_ON_START === "true",
    delayMs,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sitesPath = sitesConfigPath(env);
  return {
    sitesPath,
    cacheDir: cacheDir(env),
    thanksEngine: thanksEngine(env),
    sites: loadSites(sitesPath, env),
    qbittorrent: qbittorrentConfig(env),
    webhook: webhookConfig(env),
    scan: scanConfig(env),
  };
}
