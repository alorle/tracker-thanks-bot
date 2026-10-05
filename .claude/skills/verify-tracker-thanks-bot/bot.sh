#!/bin/sh
# Runs the bot against a verify run's fakes with an empty environment: the
# repo's .env (loaded by direnv) points at the real qBittorrent and trackers.
set -eu
run_root="$1"
shift
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo"
exec env -i PATH="$PATH" HOME="$HOME" node --env-file="$run_root/run/bot.env" src/index.ts "$@"
