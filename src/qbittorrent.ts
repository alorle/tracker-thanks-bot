import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.ts";
import { getRequiredEnv } from "./config.ts";
import { qbitApiDuration, qbitApiErrors } from "./metrics.ts";

const PREFIX = "qbittorrent";

type TorrentProperties = {
  comment: string;
};

type TorrentInfo = {
  hash: string;
  name: string;
};

type QBittorrentCredentials =
  { mode: "apikey"; apiKey: string } | { mode: "cookie"; username: string; password: string };

type QBittorrentConfig = {
  baseUrl: string;
  credentials: QBittorrentCredentials;
};

export class QBittorrentClient {
  private config: QBittorrentConfig;
  private sid: string | null = null;

  constructor(config: QBittorrentConfig) {
    this.config = config;
  }

  static fromEnv(): QBittorrentClient {
    const baseUrl = getRequiredEnv("QBIT_URL");
    const apiKey = process.env.QBIT_API_KEY;

    if (apiKey) {
      log(PREFIX, "Using API key authentication (v5.2.0+).");
      return new QBittorrentClient({
        baseUrl,
        credentials: { mode: "apikey", apiKey },
      });
    }

    return new QBittorrentClient({
      baseUrl,
      credentials: {
        mode: "cookie",
        username: getRequiredEnv("QBIT_USERNAME"),
        password: getRequiredEnv("QBIT_PASSWORD"),
      },
    });
  }

  private authHeaders(): Record<string, string> {
    if (this.config.credentials.mode === "apikey") {
      return { Authorization: `Bearer ${this.config.credentials.apiKey}` };
    }
    return { Cookie: `SID=${this.sid}` };
  }

  private async ensureAuth(): Promise<void> {
    if (this.config.credentials.mode === "apikey") return;
    if (!this.sid) await this.login();
  }

  private async handleAuthError(): Promise<void> {
    if (this.config.credentials.mode === "apikey") {
      throw new Error("qBittorrent API key rejected (HTTP 403). Check QBIT_API_KEY.");
    }
    this.sid = null;
    await this.login();
  }

  private async login(): Promise<void> {
    if (this.config.credentials.mode !== "cookie") return;
    const { username, password } = this.config.credentials;

    const res = await fetch(`${this.config.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`qBittorrent login failed: HTTP ${res.status} ${res.statusText}`);
    }
    if (body !== "Ok.") {
      throw new Error(`qBittorrent login failed: ${body} (check credentials or IP ban)`);
    }

    const cookie = res.headers.get("set-cookie");
    const sidMatch = cookie?.match(/SID=([^;]+)/);
    if (!sidMatch?.[1]) {
      throw new Error("qBittorrent login failed: no SID cookie received.");
    }
    this.sid = sidMatch[1];
    log(PREFIX, "Authenticated with qBittorrent.");
  }

  /**
   * GET an API path, re-authenticating at most once on a 403.
   *
   * The single retry is the point: a 403 that survives a fresh login is a real
   * rejection, and retrying it on every response would never terminate.
   */
  private async authedGet(path: string, endpoint: string): Promise<Response> {
    await this.ensureAuth();
    const stopTimer = qbitApiDuration.startTimer({ endpoint });

    try {
      const url = `${this.config.baseUrl}${path}`;
      let res = await fetch(url, { headers: this.authHeaders() });

      if (res.status === 403) {
        await this.handleAuthError();
        res = await fetch(url, { headers: this.authHeaders() });
      }

      if (!res.ok) {
        qbitApiErrors.inc({ endpoint });
        throw new Error(`qBittorrent API error: ${res.status} ${res.statusText}`);
      }

      return res;
    } finally {
      stopTimer();
    }
  }

  async getTorrentComment(hash: string): Promise<string> {
    const res = await this.authedGet(
      `/api/v2/torrents/properties?hash=${hash.toLowerCase()}`,
      "torrents/properties",
    );
    const props = (await res.json()) as TorrentProperties;
    return props.comment;
  }

  async getTorrentCommentWithRetry(
    hash: string,
    {
      maxAttempts = 5,
      initialDelayMs = 5000,
    }: { maxAttempts?: number; initialDelayMs?: number } = {},
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const comment = await this.getTorrentComment(hash);
        if (comment) return comment;
        log(PREFIX, `Torrent ${hash} has empty comment (attempt ${attempt}/${maxAttempts}).`);
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        log(
          PREFIX,
          `Error fetching torrent ${hash} (attempt ${attempt}/${maxAttempts}): ${String(err)}`,
        );
      }

      if (attempt < maxAttempts) {
        const delay = initialDelayMs * 2 ** (attempt - 1);
        log(PREFIX, `Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
    throw new Error(`Torrent ${hash} comment still empty after ${maxAttempts} attempts.`);
  }

  async listTorrents(): Promise<TorrentInfo[]> {
    const res = await this.authedGet("/api/v2/torrents/info", "torrents/info");
    return (await res.json()) as TorrentInfo[];
  }
}
