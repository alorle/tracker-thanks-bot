# tracker-thanks-bot

Auto-thanks bot for private trackers, driven by Radarr/Sonarr webhooks and a
daily scan of qBittorrent. When a new torrent is grabbed, the bot logs into
the tracker site with Playwright and clicks the "thanks" button on the
torrent page.

## Features

- **Webhook-driven**: receives `Grab` events from Radarr and Sonarr, looks up
  the torrent's comment in qBittorrent, parses the tracker URL, and thanks
  the upload.
- **Daily scan**: at a configurable hour, walks every torrent in qBittorrent
  and thanks any that haven't been thanked yet.
- **Per-site session reuse**: one persistent Playwright context per tracker,
  so login happens once and stays cached on disk.
- **Per-site serial queue**: concurrent webhook bursts are serialized per
  tracker so the browser context isn't torn while a click is in flight.
- **Prometheus metrics** on `/metrics`.
- **Graceful shutdown**: in-flight thank tasks finish before exit (30 s
  timeout).

## Requirements

- Node.js ≥ 24.18.0 (or Docker).
- A running qBittorrent instance (WebUI enabled).
- Radarr and/or Sonarr to send webhooks (optional — the daily scan works on
  its own).
- An account on each tracker you want to thank.

## Configuration

All configuration is via environment variables. See [.env.example](.env.example).

| Variable            | Required               | Default                                                            | Description                                                                                                                                            |
| ------------------- | ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEBHOOK_PORT`      | no                     | `3000`                                                             | HTTP port for the webhook server.                                                                                                                      |
| `WEBHOOK_SECRET`    | recommended            | —                                                                  | If set, `POST /webhook/*` requires header `X-Webhook-Secret: <value>`. If unset, the endpoints are unauthenticated and a warning is logged at startup. |
| `QBIT_URL`          | yes                    | —                                                                  | qBittorrent WebUI base URL (e.g. `http://qbit:8080`).                                                                                                  |
| `QBIT_API_KEY`      | preferred (qBit ≥ 5.2) | —                                                                  | API key. If set, takes precedence over username/password.                                                                                              |
| `QBIT_USERNAME`     | if no API key          | —                                                                  | qBittorrent WebUI username.                                                                                                                            |
| `QBIT_PASSWORD`     | if no API key          | —                                                                  | qBittorrent WebUI password.                                                                                                                            |
| `<ID>_USERNAME`     | per site               | —                                                                  | Tracker username, where `<ID>` is the Site id from `sites.json` uppercased with `-` replaced by `_` (see [Sites](#sites)).                             |
| `<ID>_PASSWORD`     | per site               | —                                                                  | Tracker password (same convention as above).                                                                                                           |
| `SITES_CONFIG_PATH` | no                     | `./config/sites.json` (source) / `/app/config/sites.json` (Docker) | Path to the Sites config file.                                                                                                                         |
| `CACHE_DIR`         | no                     | `./.cache`                                                         | Where Playwright session data is stored.                                                                                                               |
| `SCAN_ENABLED`      | no                     | `true`                                                             | Run the daily scan. Set to `false` to disable.                                                                                                         |
| `SCAN_HOUR`         | no                     | `3`                                                                | Hour (0–23) at which the daily scan runs.                                                                                                              |
| `SCAN_ON_START`     | no                     | `false`                                                            | Run a scan immediately on startup.                                                                                                                     |

## Sites

The Sites the bot operates on are defined in an operator-supplied
`sites.json`. Source code does not ship with any Site identifier.

### Schema

```json
{
  "sites": [
    {
      "id": "example",
      "base_url": "https://tracker.example.com",
      "login_button_selector": "button[type=\"submit\"]"
    }
  ]
}
```

| Field                   | Required | Default                 | Notes                                                                                                                                                                                                                                          |
| ----------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | yes      | —                       | Must match `^[a-z][a-z0-9-]{0,31}$`. Cannot be a reserved word (`serve`, `scan`, `help`, `version`, `init`, `list`, `add`, `remove`, `login`, `test`). Used as cache directory name, metrics label, log prefix, and credential env var prefix. |
| `base_url`              | yes      | —                       | Full URL of the Site. Normalized at load (host lowercased, trailing slash stripped). Two Sites cannot share the same normalized `base_url`.                                                                                                    |
| `login_button_selector` | no       | `button[type="submit"]` | CSS selector for the form submit button on the login page.                                                                                                                                                                                     |

### File location

| Mode                  | Path                                                      |
| --------------------- | --------------------------------------------------------- |
| Docker (default)      | `/app/config/sites.json` (mount your file or volume here) |
| From source (default) | `<repo>/config/sites.json`                                |
| Override (any mode)   | Set `SITES_CONFIG_PATH`                                   |

A starter file is provided at [config/sites.example.json](config/sites.example.json).

### Credentials

For each Site `id`, set `<ID>_USERNAME` and `<ID>_PASSWORD` environment
variables, where `<ID>` is the id uppercased with `-` replaced by `_`. For
example, `id: my-tracker` requires `MY_TRACKER_USERNAME` and
`MY_TRACKER_PASSWORD`. Missing credentials abort startup.

## Running

### Docker (recommended)

```sh
docker run -d --name tracker-thanks-bot \
  -p 3000:3000 \
  -v tracker-thanks-cache:/app/.cache \
  -v /path/to/your/sites.json:/app/config/sites.json:ro \
  -e WEBHOOK_SECRET=your-shared-secret \
  -e QBIT_URL=http://qbittorrent:8080 \
  -e QBIT_API_KEY=your-qbit-api-key \
  -e <ID>_USERNAME=... -e <ID>_PASSWORD=... \
  ghcr.io/alorle/tracker-thanks-bot:latest
```

Replace `<ID>` with whatever you named each Site in `sites.json` (uppercased,
`-` → `_`). Repeat the username/password pair for every Site.

Images are published to GHCR on every push to `main`.

### From source

```sh
nvm use                  # uses .node-version (24.18.0)
npm ci
npm run build
node dist/index.js serve
```

### CLI mode

Thank a specific torrent without running the server:

```sh
node dist/index.js <site> <torrentId> [<torrentId> ...]
```

Where `<site>` is a Site `id` defined in your `sites.json`.

Run a one-shot scan and exit:

```sh
node dist/index.js scan
```

## Radarr / Sonarr setup

In each app, go to **Settings → Connect → Add → Webhook**:

- **URL**: `http://<host>:3000/webhook/radarr` (or `/webhook/sonarr`).
- **Method**: POST.
- **Triggers**: enable **On Grab** only.
- **Headers**: add `X-Webhook-Secret` = `<your WEBHOOK_SECRET>` if you set
  one (strongly recommended if the server is reachable beyond your LAN).

## Endpoints

| Method | Path              | Description                                                                    |
| ------ | ----------------- | ------------------------------------------------------------------------------ |
| `POST` | `/webhook/radarr` | Radarr `Grab` webhook. Requires `X-Webhook-Secret` if `WEBHOOK_SECRET` is set. |
| `POST` | `/webhook/sonarr` | Sonarr `Grab` webhook. Same auth as above.                                     |
| `GET`  | `/health`         | Liveness probe. Returns `200 {"status":"healthy"}`.                            |
| `GET`  | `/metrics`        | Prometheus metrics.                                                            |

## Metrics

Key metrics exposed (all prefixed with `tracker_`):

- `webhooks_received_total{source,event_type}`
- `webhook_processing_duration_seconds{source,site}`
- `torrents_thanked_total{site}`, `torrents_skipped_total{site,reason}`, `torrents_errored_total{site}`
- `thank_duration_seconds{site}`
- `scans_completed_total{status}`, `scan_duration_seconds`, `scan_last_torrents_processed{result}`
- `qbittorrent_api_duration_seconds{endpoint}`, `qbittorrent_api_errors_total{endpoint}`
- `logins_total{site,status}`
- Plus the default Node.js process metrics.

## License

[MIT](LICENSE)
