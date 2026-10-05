# Health and metrics

`serve` exposes a liveness probe and Prometheus metrics so the Operator can monitor the bot.

## Sub-features

- `health` answers `200 {"status":"healthy"}`.
- `metrics` exposes `tracker_*` counters for webhooks, thanks, skips, logins and scans, plus Node process metrics.
- `not-found` answers unknown routes with `404`.

## How to get to it (user POV)

- `GET http://<host>:<port>/health`
- `GET http://<host>:<port>/metrics`

## Driving it with curl and bot.sh

Preconditions:

- `serve` is running for this run.

- **Health.** Run `curl -s -w '\n%{http_code}\n' "http://127.0.0.1:$PORT/health"`. Output is `{"status":"healthy"}` and `200`.
- **Metrics after a thanks.** Drive `webhook-radarr` first, then run `curl -s "http://127.0.0.1:$PORT/metrics" | grep '^tracker_'`. Expect `tracker_webhooks_received_total{source="radarr",event_type="Grab",...} 1`, `tracker_torrents_thanked_total{site="verify-site",...} 1` and `tracker_logins_total{site="verify-site",status="success",...} 1`.
- **Skip reasons.** After a Grab for `BBBB…`, expect `tracker_torrents_skipped_total{site="verify-site",reason="no_button",...} 1`.
- **Not found.** Run `curl -s -w '\n%{http_code}\n' "http://127.0.0.1:$PORT/nope"`. Output is `{"error":"Not found."}` and `404`.
- **Proof.** Capture the calls as `NN-health.txt` and `NN-not-found.txt`, and save the filtered metrics to `$RUN/evidence/metrics.txt` (not a capture: `pr-summary.ts` renders it in its own section).

## Gotchas

- Every metric carries an extra `app="tracker-thanks-bot"` label; match on the prefix, not the full line.
- Counters are per process. A one-shot `scan` or CLI run has no `/metrics` to read.
- Labelled counters only appear after their first increment; absence means zero.
