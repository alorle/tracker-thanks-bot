import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SiteConfig = {
  id: string;
  baseUrl: string;
  loginButtonSelector: string;
};

export type SitesMap = Map<string, SiteConfig>;

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
  // URL already lowercases hostname, but be explicit for clarity.
  url.hostname = url.hostname.toLowerCase();
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function getSitesConfigPath(): string {
  if (process.env.SITES_CONFIG_PATH) return process.env.SITES_CONFIG_PATH;
  return join(import.meta.dirname, "..", "config", "sites.json");
}

export function loadSites(path: string = getSitesConfigPath()): SitesMap {
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

  const map: SitesMap = new Map();
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
    if (map.has(id)) {
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

    let loginButtonSelector = DEFAULT_LOGIN_BUTTON_SELECTOR;
    if (entry.login_button_selector !== undefined) {
      if (typeof entry.login_button_selector !== "string" || entry.login_button_selector.length === 0) {
        fail(`Site "${id}" field "login_button_selector" must be a non-empty string.`);
      }
      loginButtonSelector = entry.login_button_selector;
    }

    map.set(id, { id, baseUrl, loginButtonSelector });
  }

  const missing: string[] = [];
  for (const site of map.values()) {
    const base = envVarBase(site.id);
    if (!process.env[`${base}_USERNAME`]) missing.push(`${base}_USERNAME`);
    if (!process.env[`${base}_PASSWORD`]) missing.push(`${base}_PASSWORD`);
  }
  if (missing.length > 0) {
    fail(`Missing required credential env vars: ${missing.join(", ")}.`);
  }

  return map;
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

export function getSiteCredentials(site: SiteConfig): { username: string; password: string } {
  const base = envVarBase(site.id);
  return {
    username: getRequiredEnv(`${base}_USERNAME`),
    password: getRequiredEnv(`${base}_PASSWORD`),
  };
}

export function getCacheDir(): string {
  return process.env.CACHE_DIR ?? join(import.meta.dirname, "..", ".cache");
}

export function getScanConfig(): { enabled: boolean; hour: number; onStart: boolean } {
  return {
    enabled: process.env.SCAN_ENABLED !== "false",
    hour: Number(process.env.SCAN_HOUR ?? "3"),
    onStart: process.env.SCAN_ON_START === "true",
  };
}
