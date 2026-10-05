# CLI thanks

The Operator can thank specific torrents on one Site by id from the terminal, without qBittorrent or the server: `node dist/index.js <site> <torrentId> [<torrentId> ...]`.

## Sub-features

- `cli-thank` thanks each listed torrent id on the named Site.
- `cli-skip` reports a per-torrent skip or refusal and carries on with the rest.
- `cli-unknown-site` prints usage when the first argument is not a configured Site.

## How to get to it (user POV)

- `node dist/index.js verify-site 101 102` (here: `"$SKILL/bot.sh" "$RUN" verify-site 101 102`).

## Driving it with curl and bot.sh

Preconditions:

- Fakes running for a fresh run. No `serve` needed.

- **Thank and skip.** Capture `CMD='"$SKILL/bot.sh" "$RUN" verify-site 101 102'` as a CLI capture. Output shows `Processing 2 torrent(s)...`, `Thanked torrent 101.`, `No thanks button found for torrent 102. Skipping.`, `Done.` and `exit=0`. `clicks` gains `101` only.
- **Refusal.** Capture `CMD='"$SKILL/bot.sh" "$RUN" verify-site 103'`. Output shows `Site rejected thanks for torrent 103: No puedes agradecer este torrent.`; no click.
- **Unknown Site.** Capture `CMD='"$SKILL/bot.sh" "$RUN" nope 1'`. Output is the usage text starting with `Usage:` and `exit=0`; no login in `fake-state.json`.
- **Proof.** `NN-cli-thank.txt`, `NN-cli-skip.txt`, `NN-cli-unknown-site.txt` (only the ones driven) and `fake-state.json`.

## Gotchas

- The Site cookie cache lives in `$RUN/run/cache` and is shared by every command of the run: after a scan or a webhook, the CLI does not log in again.
- An unknown Site prints usage and exits `0`, not an error code.
- Torrent ids here are the Site's numeric ids, not qBittorrent hashes.
