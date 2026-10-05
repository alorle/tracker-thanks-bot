# Webhook thanks

When Radarr or Sonarr grabs a torrent, it POSTs a `Grab` webhook to the bot. The bot looks the hash up in qBittorrent, finds the Site and torrent id in the torrent's comment, logs into the Site, and thanks that torrent.

## Sub-features

- `webhook-radarr` thanks the torrent named by a Radarr Grab.
- `webhook-sonarr` does the same for a Sonarr Grab.
- `webhook-auth` refuses a webhook without the right `X-Webhook-Secret`.
- `webhook-ignored` answers non-Grab events without doing anything.
- `webhook-no-hash` refuses a Grab without a `downloadId`.
- `webhook-no-site` skips a torrent whose comment matches no configured Site.
- `webhook-session-reuse` logs in once and reuses the cached session for the next Grab.

## How to get to it (user POV)

- Radarr: Settings → Connect → Webhook, URL `http://<host>:<port>/webhook/radarr`, On Grab.
- Sonarr: same, URL `/webhook/sonarr`.

## Driving it with curl and bot.sh

Preconditions:

- `serve` is running for this run and `/health` answers.
- The fake Site has not thanked `101` yet (fresh run).

- **Radarr Grab.** Run `curl -s -w '\n%{http_code}\n' -X POST "http://127.0.0.1:$PORT/webhook/radarr" -H 'Content-Type: application/json' -H 'X-Webhook-Secret: verify-secret' -d '{"eventType":"Grab","downloadId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","movie":{"title":"Thankable Movie"}}'`. Answer is `200 {"status":"accepted",...}`. `bot.log` then shows `Login successful.`, `Thanked torrent 101. (livewire v3)` and `Done processing "Thankable Movie" (verify-site torrent 101).` `fake-state.json` has one login `{"username":"verify-user","ok":true}` and one click for `101` with `"authed": true`.
- **Sonarr Grab.** Same call to `/webhook/sonarr` with `downloadId` `BBBB…` (40 × `B`) and `"series":{"title":"No Button Show"}`. `bot.log` shows `No thanks button found for torrent 102. Skipping.`; `clicks` does not grow. Use `CCCC…` instead to see `Site rejected thanks for torrent 103: No puedes agradecer este torrent.`
- **Auth.** Send the Radarr call without the header, or with a wrong value. Answer is `401 {"error":"Unauthorized."}` and `bot.log` shows `Rejected unauthenticated /webhook/radarr`.
- **Ignored event.** Send `{"eventType":"Download"}` with the secret. Answer is `200` with `"status":"ignored"`; `bot.log` shows `Ignoring event: Download`.
- **No hash.** Send `{"eventType":"Grab"}` with the secret. Answer is `400 {"error":"No downloadId found in payload."}`.
- **No matching Site.** Send a Grab with `downloadId` `DDDD…`. `bot.log` shows `No matching site URL in comment: "Source: https://unknown.example/torrents/5". Skipping.`; no new login or click.
- **Session reuse.** After the Radarr Grab, check `$RUN/run/cache/http-sessions/verify-site.json` exists with mode `-rw-------`, then send the Sonarr Grab. `logins` in `fake-state.json` stays at one.
- **Proof.** Capture each call as `NN-webhook-radarr.txt`, `NN-webhook-sonarr.txt`, `NN-webhook-auth.txt`, `NN-webhook-ignored.txt`, `NN-webhook-no-hash.txt`, `NN-webhook-no-site.txt` (only the ones driven), then `curl -s "http://127.0.0.1:$PORT/metrics" | grep '^tracker_' > "$RUN/evidence/metrics.txt"`. Expect `tracker_torrents_thanked_total{site="verify-site",...} 1` after the Radarr Grab.

## Gotchas

- The `200 accepted` comes before the work. Wait for `Done processing` or `No matching site` in `bot.log`.
- Radarr sends the hash uppercase; the fake qBittorrent matches exactly, so an uppercase `downloadId` that still thanks proves the bot lowercases it. Keep sending uppercase.
- A torrent with an empty comment makes the bot retry with backoff before giving up; the fixed scenario has none, so no long waits are expected.
- Thanking `101` twice is answered by the fake Site with `You have already thanked!`, which the bot logs as `Site rejected thanks` (the refusal classifier currently places every Site refusal as `rejected`).
- A 401 does not increment `tracker_webhooks_received_total`.
