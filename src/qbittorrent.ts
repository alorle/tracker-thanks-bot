import { log } from "./log.js";
import { getRequiredEnv } from "./config.js";
import { qbitApiDuration, qbitApiErrors } from "./metrics.js";

const PREFIX = "qbittorrent";

type TorrentProperties = {
  comment: string;
};

type TorrentInfo = {
  hash: string;
  name: string;
};

type QBittorrentCredentials =
  | { mode: "apikey"; apiKey: string }
  | { mode: "cookie"; username: string; password: string };

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

  async getTorrentComment(hash: string): Promise<string> {
    await this.ensureAuth();
    const stopTimer = qbitApiDuration.startTimer({ endpoint: "torrents/properties" });

    const res = await fetch(
      `${this.config.baseUrl}/api/v2/torrents/properties?hash=${hash.toLowerCase()}`,
      { headers: this.authHeaders() },
    );

    if (res.status === 403) {
      stopTimer();
      await this.handleAuthError();
      return this.getTorrentComment(hash);
    }

    if (!res.ok) {
      stopTimer();
      qbitApiErrors.inc({ endpoint: "torrents/properties" });
      throw new Error(`qBittorrent API error: ${res.status} ${res.statusText}`);
    }

    const props = (await res.json()) as TorrentProperties;
    stopTimer();
    return props.comment;
  }

  async getTorrentCommentWithRetry(
    hash: string,
    maxAttempts = 5,
    initialDelayMs = 5000,
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const comment = await this.getTorrentComment(hash);
        if (comment) return comment;
        log(PREFIX, `Torrent ${hash} has empty comment (attempt ${attempt}/${maxAttempts}).`);
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        log(PREFIX, `Error fetching torrent ${hash} (attempt ${attempt}/${maxAttempts}): ${err}`);
      }

      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        log(PREFIX, `Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(`Torrent ${hash} comment still empty after ${maxAttempts} attempts.`);
  }

  async listTorrents(): Promise<TorrentInfo[]> {
    await this.ensureAuth();
    const stopTimer = qbitApiDuration.startTimer({ endpoint: "torrents/info" });

    const res = await fetch(`${this.config.baseUrl}/api/v2/torrents/info`, {
      headers: this.authHeaders(),
    });

    if (res.status === 403) {
      stopTimer();
      await this.handleAuthError();
      return this.listTorrents();
    }

    if (!res.ok) {
      stopTimer();
      qbitApiErrors.inc({ endpoint: "torrents/info" });
      throw new Error(`qBittorrent API error: ${res.status} ${res.statusText}`);
    }

    const result = (await res.json()) as TorrentInfo[];
    stopTimer();
    return result;
  }
}
