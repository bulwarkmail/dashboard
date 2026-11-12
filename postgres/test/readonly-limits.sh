#!/usr/bin/env bash
# The read-only logins' limits hold whatever their sessions do (next to effective-privileges.sh).
# Needs Docker and postgres:16-alpine. Its containers and network are named NAME_PREFIX-*
# (default readonly-limits-*) and removed at the end. Every password is a fake made here.
#
#   bash postgres/test/readonly-limits.sh <dashboard repo root>
#
# 1. A statement of a read-only login ends within a minute even when it catches the cancel the
#    query-watchdog sends (PL/pgSQL can trap query_canceled; DO blocks are open to every role).
# Exit 0 when it holds, 1 otherwise.
set -u
ROOT="$(cd "${1:?usage: readonly-limits.sh <repo root>}" && pwd)"
P="${NAME_PREFIX:-readonly-limits}"
PG="$P-pg-$$"; WD="$P-wd-$$"; NET="$P-net-$$"
# Git Bash on Windows would rewrite container paths like /watchdog into Windows paths.
export MSYS_NO_PATHCONV=1
w() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
trap 'docker rm -f -v "$PG" "$WD" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1' EXIT
fail=0
docker network create "$NET" >/dev/null
envs=(-e POSTGRES_PASSWORD=fake-super)
for var in $(cat "$ROOT"/postgres/*.sql | grep -o '\$POSTGRES_[A-Z_]*' | tr -d '$' | sort -u); do envs+=(-e "$var=fake-$var"); done
docker create --name "$PG" --network "$NET" --network-alias postgres "${envs[@]}" postgres:16-alpine >/dev/null
docker cp "$(w "$ROOT/postgres/init.sql")" "$PG:/docker-entrypoint-initdb.d/10-init.sql" >/dev/null
docker cp "$(w "$ROOT/postgres/grafana-read-only.sql")" "$PG:/docker-entrypoint-initdb.d/20-grafana-read-only.sql" >/dev/null
docker start "$PG" >/dev/null
for _ in $(seq 1 90); do docker logs "$PG" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$PG" pg_isready -q -U postgres -h 127.0.0.1 && break; sleep 1; done
# The query-watchdog service as docker-compose.yml runs it.
docker run -d --name "$WD" --network "$NET" --user postgres --read-only --tmpfs /var/lib/postgresql/data --cap-drop ALL \
  -e PGHOST=postgres -e PGUSER=grafana_query_watchdog -e PGDATABASE=postgres -e PGPASSWORD=fake-POSTGRES_QUERY_WATCHDOG_PASSWORD \
  -v "$(w "$ROOT/postgres/watchdog"):/watchdog:ro" --entrypoint /bin/sh postgres:16-alpine /watchdog/query-watchdog.sh >/dev/null

echo "== 1. a statement that catches the watchdog's cancel"
docker exec -d "$PG" psql -X -q -h 127.0.0.1 -U grafana_telemetry_ro -d telemetry -c \
  "SET statement_timeout = 0; DO \$\$ BEGIN LOOP BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END; END LOOP; END \$\$"
sleep 60
n=$(docker exec "$PG" psql -X -At -U postgres -c "SELECT count(*) FROM pg_stat_activity WHERE usename = 'grafana_telemetry_ro' AND state = 'active'")
if [ "$n" = 0 ]; then echo "  ok    it was ended within 60 s"; else echo "  FAIL  it still runs after 60 s ($(docker logs "$WD" 2>&1 | grep -c 'cancelled statements') cancels by the watchdog had no effect)"; fail=1; fi
docker exec "$PG" psql -X -At -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'grafana_telemetry_ro'" >/dev/null

echo
[ "$fail" = 0 ] && echo "all ok" || echo "FAILED"
exit "$fail"
