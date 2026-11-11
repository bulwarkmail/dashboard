#!/bin/sh
# The query-watchdog service (docker-compose.yml): runs query-watchdog.sql every
# 5 seconds against the postgres service, with the PG* variables compose sets.
# Prints a line only when it cancelled or ended something, or when psql failed.
while :; do
  if out=$(psql -X -q -At -F ' ' -f /watchdog/query-watchdog.sql 2>&1); then
    [ "$out" = "0 0" ] || echo "query-watchdog: cancelled statements, ended sessions: $out"
  else
    echo "query-watchdog: $out" >&2
  fi
  sleep 5
done
