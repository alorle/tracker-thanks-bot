---
name: verify-tracker-thanks-bot
description: Launch and drive tracker-thanks-bot (HTTP webhook server plus `scan` and `<site> <id>` CLI) against local fake qBittorrent and fake tracker servers, and capture proof that a Thanks really landed. Use when you need to confirm a change works in the running bot, not just in unit tests: webhook → thanks, daily/one-shot scan, CLI thanks, health and metrics.
---

# Verify tracker-thanks-bot

The bot has no UI. A user touches it three ways: Radarr/Sonarr POST a `Grab` webhook to `serve`, the Operator runs `scan`, or the Operator runs `<site> <torrentId>...`. Everything it does lands on two external HTTP systems, qBittorrent and the tracker Site. This skill runs the real bot process (`node src/index.ts`, no build needed on Node 26) against the repo's own HTTP fakes (`test/fake-qbittorrent.ts`, `test/fake-tracker.ts`), which sit exactly at that production boundary.

**Never run the bot with the repo's environment.** `.env` is loaded by direnv and holds the Operator's real `QBIT_URL`, API key and tracker credentials: a verification run with it would thank real torrents on real private trackers. Always go through `bot.sh`, which starts node under `env -i` with only the run's `bot.env`.

## Layout of a run

Pick a run dir. Use the session scratchpad if you have one, otherwise `mktemp -d`:

```sh
SKILL=.claude/skills/verify-tracker-thanks-bot
RUN="<scratchpad>/verify-$(date +%Y%m%d-%H%M%S)"   # or: RUN="$(mktemp -d)/verify"
mkdir -p "$RUN/evidence"
```

- `$RUN/run/` is scratch: `sites.json`, `bot.env`, the session cookie cache, pid files. Cleanup deletes it.
- `$RUN/evidence/` is proof: logs, responses, fake state. Cleanup never touches it. Report its path to the user.

Runs are fully isolated (ephemeral ports, own cache dir), so several can run side by side. Never drive a bot you did not start in this run: the Operator may have a production one on port 3000.

## Launch

All commands run from the repo root.

1. Start the fakes (fixed scenario, see below). Ready when the log prints `FAKES READY`:

   ```sh
   node "$SKILL/fakes.ts" "$RUN" > "$RUN/evidence/fakes.log" 2>&1 &
   until grep -q "FAKES READY" "$RUN/evidence/fakes.log"; do sleep 0.25; done
   cat "$RUN/evidence/fakes.log"
   ```

   It writes `$RUN/run/fakes.pid`, `$RUN/run/sites.json`, `$RUN/run/bot.env`, and keeps `$RUN/evidence/fake-state.json` updated every 200 ms with the tracker's `logins`, `clicks`, `trackerRequests` and qBittorrent's `qbitRequests`.

2. For the server, start `serve` and wait for `/health`:

   ```sh
   PORT=$(sed -n 's/^WEBHOOK_PORT=//p' "$RUN/run/bot.env")
   "$SKILL/bot.sh" "$RUN" serve > "$RUN/evidence/bot.log" 2>&1 &
   echo $! > "$RUN/run/bot.pid"
   until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; do sleep 0.25; done
   ```

   The log also prints `[webhook] Listening on port <PORT>`.

3. For the CLI (`scan`, `<site> <id>...`) there is no server: run `bot.sh` in the foreground per command, as a CLI capture (see [Drive](#drive)).

### The fixed scenario

| Thing                   | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| Site id                 | `verify-site` (base URL is the fake tracker's `http://127.0.0.1:<port>`) |
| Site credentials        | `verify-user` / `verify-pw` (accepted by the fake)                       |
| qBittorrent             | cookie auth, `qbit-user` / `qbit-pw`                                     |
| Webhook secret          | `verify-secret` (header `X-Webhook-Secret`)                              |
| Hash `aaaa…` (40 × `a`) | comment points at Site torrent `101`: thankable                          |
| Hash `bbbb…`            | torrent `102`: the Site renders no thanks button                         |
| Hash `cccc…`            | torrent `103`: Site refuses with `No puedes agradecer este torrent.`     |
| Hash `dddd…`            | comment points at `https://unknown.example`: matches no Site             |
| Scan                    | `SCAN_ENABLED=false` for `serve`, `SCAN_DELAY_MS=0`                      |

The fake tracker remembers what it was thanked for the life of the fakes process: a second Thanks of `101` comes back as a refusal. Restart the fakes (new run) to get a clean Site.

## Doctor

Run before driving, and whenever anything looks off:

```sh
PORT=$(sed -n 's/^WEBHOOK_PORT=//p' "$RUN/run/bot.env")
kill -0 "$(cat "$RUN/run/fakes.pid")" && echo "fakes up"
kill -0 "$(cat "$RUN/run/bot.pid")" && echo "bot up"            # serve only
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | grep -w "$(cat "$RUN/run/bot.pid")"
curl -s "http://127.0.0.1:$PORT/health"                          # {"status":"healthy"}
grep -E 'QBIT_URL|SITES_CONFIG_PATH' "$RUN/evidence/bot.log"     # must be 127.0.0.1 and $RUN paths
```

If `bot.log` shows a `QBIT_URL` that is not `127.0.0.1`, or any `*_USERNAME` line other than `VERIFY_SITE_USERNAME`, the real environment leaked in: stop it immediately with the cleanup and do not continue.

## Drive

Recipes per feature live in [features/README.md](features/README.md). The core move is a Radarr Grab:

```sh
CMD="curl -s -w '\n%{http_code}\n' -X POST http://127.0.0.1:$PORT/webhook/radarr -H 'Content-Type: application/json' -H 'X-Webhook-Secret: verify-secret' -d '{\"eventType\":\"Grab\",\"downloadId\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"movie\":{\"title\":\"Thankable Movie\"}}'"
{ printf '$ %s\n' "$CMD"; eval "$CMD"; } | tee "$RUN/evidence/01-webhook-radarr.txt"
until grep -q 'Done processing\|No matching site' "$RUN/evidence/bot.log"; do sleep 0.25; done
```

Save every action as `evidence/NN-<sub-feature>.txt` with the command as its first line (`$ ...`) and its answer below, as above. The `NN-` prefix keeps them in order and the command line is what makes the capture readable as proof. The feature recipes give the command to put in `CMD` and the file name.

For a CLI command, single-quote `CMD` so the capture shows `$RUN` instead of the local path, redirect instead of piping so the exit code is the bot's, and record it:

```sh
CMD='"$SKILL/bot.sh" "$RUN" scan'
{ printf '$ %s\n' "$CMD"; eval "$CMD"; echo "exit=$?"; } > "$RUN/evidence/01-scan-once.txt" 2>&1
```

The webhook answers `200 {"status":"accepted"}` before doing the work; the Thanks happens in the background. Wait on the log line, never on the HTTP answer.

## Evidence

Proof standards:

- Exercise the real user path: a webhook over HTTP, or the CLI as the Operator types it. Never call `createThanks` or other internals.
- Capture the action (the request or command and its answer) and the resulting state, not just a final log line.
- Prove the side effect on the Site from the fake's side: `fake-state.json` `clicks` gains the expected `torrentId` with `"authed": true`, `logins` shows the attempt. Pair it with the bot's own log (`Thanked torrent 101.`) and, for `serve`, `/metrics`.
- The fakes are the only mocks, and they stand where the production boundary already is (HTTP to qBittorrent and to the Site). Nothing inside the bot is faked.
- Session persistence is a side effect too: `$RUN/run/cache/http-sessions/verify-site.json` must exist with mode `-rw-------`. Copy what you need into `evidence/` before cleanup, since `run/` is deleted.

Useful captures:

```sh
curl -s "http://127.0.0.1:$PORT/metrics" | grep '^tracker_' > "$RUN/evidence/metrics.txt"
python3 -c "import json,sys;s=json.load(open(sys.argv[1]));print(s['logins'],s['clicks'])" "$RUN/evidence/fake-state.json"
ls -l "$RUN/run/cache/http-sessions" > "$RUN/evidence/session-cache.txt"
```

### Optional: PR attachment

Only when the user wants the proof for a pull request. After cleanup (it reads only `evidence/`, and the fakes write their final state on stop):

```sh
node "$SKILL/pr-summary.ts" "$RUN" "webhook-radarr thanks the grabbed torrent"
```

It writes `$RUN/evidence/PR.md` and prints it: the git revision (flagging uncommitted changes), each `*.txt` action capture and the bot log (both without `[config]` lines), what the fake Site saw (logins and thanks, authenticated or not), the `tracker_*` metrics and the session cache listing. Read it before handing it over: it shows exactly what ran, so if the run drove the wrong thing the summary will say so. Hand the file to the user to paste into the PR body; do not post it to GitHub yourself unless asked.

## Cleanup

```sh
"$SKILL/cleanup.sh" "$RUN"
```

It sends SIGTERM to the pids in `$RUN/run/bot.pid` and `$RUN/run/fakes.pid` (the bot drains and logs `Shutdown complete.`; the fakes write a final `fake-state.json`), escalates to SIGKILL after 5 s, deletes `$RUN/run/`, and lists what is left in `$RUN/evidence/`. It only kills what this run started; never `pkill node`. Run it after failed attempts too.

## Helpers

All executable, all take the run dir as first argument:

- `node "$SKILL/fakes.ts" "$RUN"`: start fake tracker and fake qBittorrent with the fixed scenario, write `run/bot.env` and `run/sites.json`, keep `evidence/fake-state.json` current.
- `"$SKILL/bot.sh" "$RUN" <args>`: run `node src/index.ts <args>` under `env -i` with `run/bot.env`. Args are `serve`, `scan`, or `verify-site <id>...`.
- `"$SKILL/cleanup.sh" "$RUN"`: stop this run's processes, delete `run/`, keep `evidence/`.
- `node "$SKILL/pr-summary.ts" "$RUN" ["<title>"]`: optional, build `evidence/PR.md` from the evidence for a PR body.

`fakes.ts` imports the fakes straight from `test/`. If a fake's options change, update `fakes.ts` and the scenario table together.
