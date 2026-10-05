# tracker-thanks-bot verification map

This directory is the maintained source for verifying the user-facing behavior of tracker-thanks-bot. Read the index before driving the bot, then use the matching feature file as the recipe.

## Baseline preconditions

- A fresh run dir `$RUN` with fakes started by `node "$SKILL/fakes.ts" "$RUN"` and `FAKES READY` in `$RUN/evidence/fakes.log`.
- `SKILL=.claude/skills/verify-tracker-thanks-bot`, commands run from the repo root.
- For server features, `serve` started through `"$SKILL/bot.sh" "$RUN" serve` and `PORT` read from `$RUN/run/bot.env`.
- The doctor in `SKILL.md` passes, in particular `QBIT_URL` in `bot.log` is `127.0.0.1`.
- Never drive a bot instance that was not started by this run.

## Driving conventions

- The harness is `curl` for the server and `bot.sh` for the CLI. Nothing else talks to the bot.
- Webhook processing is asynchronous: wait for the log line, not the HTTP answer.
- The fake Site keeps its thanked set for the life of the fakes. Start a new run to get a clean Site.
- Run every action as a capture (`SKILL.md`, Drive): the command goes in `CMD` and the capture in `evidence/NN-<sub-feature>.txt`, number by run order. CLI captures single-quote `CMD`, redirect instead of piping and record `exit=$?`. Each recipe's **Proof** bullet names its capture files.

## Proof and skip reporting

- Record the request or command, the bot's answer, the bot's log, and the fake's view in `fake-state.json`.
- A Thanks counts as proven only when `clicks` in `fake-state.json` gains that `torrentId` with `"authed": true`.
- A skip counts as proven only when the expected log line appears and `clicks` does not grow.
- Name the feature ID and entry point with every artifact.
- Do not report a skipped entry point (say Sonarr) as verified through a different one (Radarr).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with curl and bot.sh`, `Gotchas`.

## Features

- [Webhook thanks](./webhook-thanks.md) covers Radarr and Sonarr Grab webhooks, auth, ignored events, and unmatched torrents.
- [Scan](./scan.md) covers the one-shot `scan` command and the scan on `serve` startup.
- [CLI thanks](./cli-thanks.md) covers thanking specific Site torrent ids from the terminal.
- [Health and metrics](./health-metrics.md) covers `/health` and the Prometheus `/metrics` endpoint.
