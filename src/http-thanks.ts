import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envVarBase, getCacheDir, type SiteConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  torrentsThanked,
  torrentsSkipped,
  torrentsErrored,
  thankDuration,
  logins,
} from "./metrics.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

type Jar = Map<string, string>;
type RequestInit = {
  method?: string;
  body?: string | URLSearchParams;
  headers?: Record<string, string>;
};
type Fetched = { status: number; url: string; body: string };

/** The `store()` call as the Engine's two Livewire generations expect it. */
type ThankButton = {
  livewire: 2 | 3;
  /** The component payload exactly as the HTML served it — it is server-signed. */
  snapshot: string;
  componentName: string;
  fingerprint?: unknown;
  serverMemo?: unknown;
  disabled: boolean;
};

type Dispatch = {
  name?: string; // Livewire 3
  event?: string; // Livewire 2
  params?: { message?: string }; // Livewire 3
  data?: { message?: string }; // Livewire 2
};
type Effects = { dispatches?: Dispatch[] };

const jars = new Map<string, Jar>();

function jarPath(siteKey: string): string {
  return join(getCacheDir(), "http-sessions", `${siteKey}.json`);
}

function loadJar(siteKey: string): Jar {
  const cached = jars.get(siteKey);
  if (cached) return cached;

  let jar: Jar = new Map();
  try {
    const stored = JSON.parse(readFileSync(jarPath(siteKey), "utf-8")) as Record<string, string>;
    jar = new Map(Object.entries(stored));
  } catch {
    // No persisted session yet (or an unreadable one): start clean and log in.
  }
  jars.set(siteKey, jar);
  return jar;
}

/** Session cookies are credentials: keep them owner-readable only. */
function saveJar(siteKey: string, jar: Jar): void {
  const path = jarPath(siteKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(jar)), { mode: 0o600 });
}

function storeCookies(jar: Jar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

/**
 * Fetch with a cookie jar, following redirects by hand.
 *
 * `redirect: "follow"` hides the Set-Cookie headers of the intermediate hops,
 * and the session cookie is handed out on exactly such a hop: the 302 that
 * answers the login POST.
 */
async function request(jar: Jar, url: string, init: RequestInit = {}): Promise<Fetched> {
  let current = url;
  let options = init;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      method: options.method,
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        ...(jar.size > 0 && {
          Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        }),
        ...options.headers,
      },
    });
    storeCookies(jar, response);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, current).toString();
      // A browser follows a post-redirect with a bodyless GET; so do we.
      options = {};
      continue;
    }

    return { status: response.status, url: current, body: await response.text() };
  }

  throw new Error(`Too many redirects fetching ${url}.`);
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The full HTML tag that carries the attribute found at `index`. */
function tagAt(html: string, index: number): string {
  const start = html.lastIndexOf("<", index);
  let end = index;
  let quote: string | null = null;
  while (end < html.length) {
    const char = html[end];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      break;
    }
    end++;
  }
  return html.slice(start, end + 1);
}

/**
 * Locate the thanks component in the page HTML.
 *
 * Matching on `wire:click="store(id)"` is not enough: the bookmark button
 * carries the very same call. The component name is what tells them apart,
 * and unlike the button label it does not depend on the Site's language.
 */
export function findThankButton(html: string): ThankButton | null {
  // Livewire 3 serves `wire:snapshot`, Livewire 2 `wire:initial-data`.
  for (const attribute of ["wire:snapshot", "wire:initial-data"] as const) {
    const pattern = new RegExp(`${attribute}="([^"]*)"`, "g");
    for (const match of html.matchAll(pattern)) {
      const snapshot = decodeEntities(match[1] ?? "");
      let parsed: {
        memo?: { name?: string };
        fingerprint?: { name?: string };
        serverMemo?: unknown;
      };
      try {
        parsed = JSON.parse(snapshot) as typeof parsed;
      } catch {
        continue;
      }
      const componentName = parsed.memo?.name ?? parsed.fingerprint?.name;
      if (componentName !== "thank-button") continue;

      return {
        livewire: attribute === "wire:snapshot" ? 3 : 2,
        snapshot,
        componentName,
        fingerprint: parsed.fingerprint,
        serverMemo: parsed.serverMemo,
        disabled: /\sdisabled(\s|=|>|\/)/.test(tagAt(html, match.index)),
      };
    }
  }
  return null;
}

async function login(
  jar: Jar,
  site: SiteConfig,
  username: string,
  password: string,
  logPrefix: string,
): Promise<void> {
  log(logPrefix, "Login required. Submitting credentials...");

  const loginUrl = `${site.baseUrl}/login`;
  const page = await request(jar, loginUrl);

  // Re-send every field the form serves, then override the credentials. Beyond
  // Laravel's CSRF token the Engine ships honeypot fields whose names are
  // randomized on each request, so the form has to be read before it is posted.
  const form = /<form[^>]*action="[^"]*\/login"[\s\S]*?<\/form>/i.exec(page.body)?.[0] ?? page.body;
  const fields = new URLSearchParams();
  for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/.exec(input[0])?.[1];
    if (!name) continue;
    fields.set(name, decodeEntities(/\bvalue="([^"]*)"/.exec(input[0])?.[1] ?? ""));
  }
  fields.set("username", username);
  fields.set("password", password);

  const submitted = await request(jar, loginUrl, {
    method: "POST",
    body: fields,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (submitted.url.includes("/login")) {
    logins.inc({ site: site.id, status: "failure" });
    const base = envVarBase(site.id);
    throw new Error(`Login failed. Check your ${base}_USERNAME and ${base}_PASSWORD.`);
  }

  logins.inc({ site: site.id, status: "success" });
  log(logPrefix, "Login successful.");
}

/** Invoke the component's `store()`. Returns the Site's rejection, if any. */
async function callStore(
  jar: Jar,
  site: SiteConfig,
  button: ThankButton,
  torrentId: string,
  csrfToken: string,
  torrentUrl: string,
): Promise<string | null> {
  const id = Number(torrentId);
  const [url, payload] =
    button.livewire === 3
      ? [
          `${site.baseUrl}/livewire/update`,
          {
            _token: csrfToken,
            components: [
              {
                snapshot: button.snapshot,
                updates: {},
                calls: [{ path: "", method: "store", params: [id] }],
              },
            ],
          },
        ]
      : [
          `${site.baseUrl}/livewire/message/${button.componentName}`,
          {
            fingerprint: button.fingerprint,
            serverMemo: button.serverMemo,
            updates: [
              { type: "callMethod", payload: { id: "thanks", method: "store", params: [id] } },
            ],
          },
        ];

  const response = await request(jar, url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      Accept: "text/html, application/xhtml+xml",
      "X-Livewire": "true",
      "X-CSRF-TOKEN": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
      Referer: torrentUrl,
    },
  });

  if (response.status !== 200) {
    throw new Error(`Livewire call returned ${response.status}.`);
  }

  // Both generations answer 200 whatever happens; the outcome rides in the
  // dispatched browser event. Livewire 2 names it `event`/`data`, 3 `name`/`params`.
  let effects: Effects | undefined;
  try {
    const json = JSON.parse(response.body) as {
      effects?: Effects;
      components?: { effects?: Effects }[];
    };
    effects = json.components?.[0]?.effects ?? json.effects;
  } catch {
    throw new Error("Livewire call returned a non-JSON body.");
  }

  for (const dispatch of effects?.dispatches ?? []) {
    if ((dispatch.name ?? dispatch.event) !== "error") continue;
    return (dispatch.params ?? dispatch.data)?.message ?? "unknown error";
  }
  return null;
}

export async function thankTorrentHttp(
  siteKey: string,
  torrentId: string,
  username: string,
  password: string,
  site: SiteConfig,
  logPrefix: string,
): Promise<void> {
  const siteLabel = site.id;
  const stopTimer = thankDuration.startTimer({ site: siteLabel });
  const jar = loadJar(siteKey);

  try {
    const url = `${site.baseUrl}/torrents/${torrentId}`;
    log(logPrefix, `Fetching torrent ${torrentId}...`);

    let page = await request(jar, url);
    if (page.url.includes("/login")) {
      await login(jar, site, username, password, logPrefix);
      page = await request(jar, url);
      if (page.url.includes("/login")) {
        throw new Error("Logged in but the torrent page still redirects to /login.");
      }
    }

    const button = findThankButton(page.body);
    if (!button) {
      log(logPrefix, `No thanks button found for torrent ${torrentId}. Skipping.`);
      torrentsSkipped.inc({ site: siteLabel, reason: "no_button" });
      return;
    }

    // Only Livewire 2 renders the button disabled once thanked; on Livewire 3
    // the Site rejects the duplicate call instead, handled below.
    if (button.disabled) {
      log(logPrefix, `Torrent ${torrentId} already thanked. Skipping.`);
      torrentsSkipped.inc({ site: siteLabel, reason: "already_thanked" });
      return;
    }

    const csrfToken = /<meta name="csrf-token" content="([^"]*)"/.exec(page.body)?.[1];
    if (!csrfToken) {
      throw new Error("No csrf-token meta tag on the torrent page.");
    }

    const rejection = await callStore(jar, site, button, torrentId, csrfToken, url);
    if (rejection) {
      log(logPrefix, `Site rejected thanks for torrent ${torrentId}: ${rejection}`);
      torrentsSkipped.inc({ site: siteLabel, reason: "rejected" });
      return;
    }

    torrentsThanked.inc({ site: siteLabel });
    log(logPrefix, `Thanked torrent ${torrentId}. (livewire v${button.livewire})`);
  } catch (err) {
    torrentsErrored.inc({ site: siteLabel });
    throw err;
  } finally {
    stopTimer();
    saveJar(siteKey, jar);
  }
}
