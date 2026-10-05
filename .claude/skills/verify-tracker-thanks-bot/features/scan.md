# Scan

The scan walks every torrent in qBittorrent and thanks each one whose comment points at a configured Site. The Operator runs it once with `scan`, or `serve` runs it daily at `SCAN_HOUR` and optionally on startup.

## Sub-features

- `scan-once` runs a full scan from the CLI and exits.
- `scan-outcomes` thanks, skips and refuses per torrent, and reports totals.
- `scan-on-start` runs a scan as soon as `serve` starts when `SCAN_ON_START=true`.

## How to get to it (user POV)

- `node dist/index.js scan` (here: `"$SKILL/bot.sh" "$RUN" scan`).
- `serve` with `SCAN_ENABLED=true` and `SCAN_ON_START=true`.
- `serve` with `SCAN_ENABLED=true` at hour `SCAN_HOUR` (not practical to drive; see Gotchas).

## Driving it with curl and bot.sh

Preconditions:

- Fakes running for a fresh run. No `serve` needed for `scan-once`.

- **One-shot scan.** Capture `CMD='"$SKILL/bot.sh" "$RUN" scan'` as a CLI capture. Output shows `Found 4 torrent(s) in qBittorrent.`, `Thanked torrent 101.`, `No thanks button found for torrent 102. Skipping.`, `Site rejected thanks for torrent 103: No puedes agradecer este torrent.`, then `Scan complete. Processed: 1, Skipped: 3, Errors: 0` and `exit=0`. `fake-state.json` has exactly one click, for `101`.
- **Scan on start.** Append `SCAN_ENABLED=true` and `SCAN_ON_START=true` to `$RUN/run/bot.env` before starting `serve` (later lines win). `bot.log` shows `[scheduler] Next scan scheduled at ...` then `Starting torrent scan...` right after the `Listening on port` and `Endpoints:` lines, then the same totals. `/metrics` shows `tracker_scans_completed_total{status="success",...} 1`.
- **Proof.** `NN-scan-once.txt` (with its `exit=` line) and `fake-state.json`. For `scan-on-start` there is no command to capture: `bot.log` carries the scan, so capture `curl -s "http://127.0.0.1:$PORT/metrics"` filtered to `scans_completed` as `NN-scan-on-start.txt`.

## Gotchas

- The foreign torrent (`dddd…`) counts as skipped, so the total is 3 skipped, not 2.
- A second scan in the same run finds `101` already thanked and reports it as `Site rejected thanks ... You have already thanked!`, with `Processed: 0`.
- The daily trigger only fires at `SCAN_HOUR`; verifying it means waiting for the wall clock. Cover the scan behavior through `scan-once` and say the scheduler itself was not driven.
- Only `serve` handles SIGTERM itself; a one-shot `scan` just exits when done.
