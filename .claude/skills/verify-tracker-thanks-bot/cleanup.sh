#!/bin/sh
# Stops what a verify run started and removes its scratch state; evidence/ stays.
set -u
run_root="$1"
for pidfile in "$run_root"/run/bot.pid "$run_root"/run/fakes.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null
done
rm -rf "$run_root/run"
ls "$run_root/evidence"
