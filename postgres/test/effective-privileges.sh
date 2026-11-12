#!/usr/bin/env bash
# What the roles Grafana's data sources log in with can really do.
#
# Starts a throwaway Postgres 16 from postgres/init.sql, lets the apps' own
# roles create their tables afterwards (as on a real host), runs every other
# .sql file in postgres/ as the superuser twice, and then asks Postgres, as
# each data source's role, what is allowed: reading the dashboards' tables,
# and nothing that writes, creates or reads what the dashboards don't show.
# Then the owners create tables again, as a later collector version would,
# and every panel's SQL of every dashboard runs as its data source's role.
#
# Needs Docker (the image postgres:16-alpine) and node. Touches nothing but
# its own container, which it removes at the end with its volume. Every
# password is a fake made here.
#
#   bash postgres/test/effective-privileges.sh <dashboard repo root>
#
# Exit 0 when every line says ok, 1 otherwise.
set -u
ROOT="${1:?usage: effective-privileges.sh <dashboard repo root>}"
ROOT=$(cd "$ROOT" && pwd) || exit 2
# Git Bash on Windows would rewrite container paths like /tmp/x into Windows paths.
export MSYS_NO_PATHCONV=1
NAME="grafana-ro-check-$$"
fail=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

envs=()
for var in $(cat "$ROOT"/postgres/*.sql | grep -o '\$POSTGRES_[A-Z_]*' | tr -d '$' | sort -u); do
  envs+=(-e "$var=fake-$var")
done

MSYS_NO_PATHCONV=1 docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=fake-superuser "${envs[@]}" \
  -v "$(winpath "$ROOT/postgres/init.sql"):/docker-entrypoint-initdb.d/10-init.sql:ro" postgres:16-alpine >/dev/null || { echo "could not start postgres"; exit 2; }
ERR=$(mktemp)
trap 'docker rm -f -v "$NAME" >/dev/null 2>&1; rm -f "$ERR"' EXIT

# The image starts once for the init scripts and again for real: wait for the second start.
for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$NAME" pg_isready -q -U postgres -h 127.0.0.1; then break; fi
  sleep 1
done

psql_as() { # role, database, sql  -> stdout, exit code of psql
  docker exec "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$2" -c "SET ROLE \"$1\"" -c "$3" 2>&1 </dev/null
}
super() { docker exec "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2" 2>&1 </dev/null; }
schema_as() { # role, database, file
  docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$2" -c "SET client_min_messages = warning" -c "SET ROLE $1" -f - < "$3" >/dev/null
}

# Tables, created by the owners after init, as the collectors and Umami do at their first start.
schema_as dashboard dashboard "$ROOT/collector/src/schema.sql" || bad "collector schema did not load"
schema_as telemetry telemetry "$ROOT/telemetry-collector/src/schema.sql" || bad "telemetry schema did not load"
# Stand-ins for Umami's tables (the image is not started): the login table, a table with
# two-factor secrets, and the columns the dashboards read.
psql_as umami umami 'CREATE TABLE "user" (user_id uuid PRIMARY KEY, username text, password text);
  CREATE TABLE two_factor_auth (user_id uuid PRIMARY KEY, secret text);
  CREATE TABLE website (website_id uuid PRIMARY KEY, name text, deleted_at timestamptz);
  CREATE TABLE session (session_id uuid PRIMARY KEY, website_id uuid, country text);
  CREATE TABLE website_event (event_id uuid PRIMARY KEY, website_id uuid, session_id uuid, created_at timestamptz, url_path text, event_type int, event_name text, referrer_domain text);
  CREATE TABLE event_data (event_data_id uuid PRIMARY KEY, website_event_id uuid, data_key text, string_value text)' >/dev/null || bad "umami stand-in tables"
super dashboard "INSERT INTO collector_runs (job, error) VALUES ('git', 'text that may hold a credential')" >/dev/null
super dashboard "INSERT INTO repos (id, owner, name, default_branch) VALUES ('acme/app', 'acme', 'app', 'main')" >/dev/null
# What a signed-in user could leave behind while the data sources logged in as the owners: grants to
# PUBLIC and default privileges for PUBLIC. The grants file has to take them away.
psql_as dashboard dashboard "GRANT ALL ON repos TO PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE dashboard IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE dashboard GRANT ALL ON TABLES TO PUBLIC" >/dev/null || bad "leftovers in dashboard"
psql_as telemetry telemetry "GRANT ALL ON expired_instances TO PUBLIC; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC" >/dev/null || bad "leftovers in telemetry"

# Most hosts have no Warden bot and so no warden database: the grants file leaves it out there.
if docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < "$ROOT/postgres/grafana-read-only.sql" >/dev/null 2>"$ERR"; then
  ok "grafana-read-only.sql runs where there is no warden database"
else
  bad "grafana-read-only.sql fails where there is no warden database: $(tail -1 "$ERR")"
fi
# The Warden bot's database as the bot makes it (github-discord-bot, src/warden/ledger.js): its own
# role owns the database and its tables. A second table stands for anything the dashboard doesn't
# show. The Warden data source used to log in as the owner, so a user could have left a grant to
# PUBLIC behind.
super postgres "CREATE ROLE warden LOGIN PASSWORD 'fake-warden'" >/dev/null || bad "warden role"
super postgres "CREATE DATABASE warden OWNER warden" >/dev/null || bad "warden database"
psql_as warden warden "CREATE TABLE warden_runs (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
    platform text NOT NULL, kind text NOT NULL, place text, url text, author text, route text, action text,
    check_result text, rounds integer, seconds numeric, input_tokens integer, cache_read integer,
    cache_write integer, output_tokens integer, cost_usd numeric, cost_by_model jsonb, posted boolean, reason text);
  CREATE INDEX warden_runs_ts ON warden_runs (ts);
  CREATE TABLE warden_notes (note text);
  INSERT INTO warden_runs (platform, kind, cost_usd) VALUES ('github', 'new_issue', 0.01);
  GRANT ALL ON warden_runs TO PUBLIC" >/dev/null || bad "warden stand-in tables"

# Everything else in postgres/ is run as the superuser, twice: the grants file has to be safe to run
# on every deploy, and it is what the owner runs on a host where init.sql ran long ago.
for file in "$ROOT"/postgres/*.sql; do
  [ "$(basename "$file")" = init.sql ] && continue
  for pass in first second; do
    if docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < "$file" >/dev/null 2>"$ERR"; then
      ok "$(basename "$file") ran ($pass time)"
    else
      bad "$(basename "$file") failed the $pass time: $(tail -1 "$ERR")"
    fi
  done
done

expect_refused() { # what, role, db, sql
  if out=$(psql_as "$2" "$3" "$4"); then bad "$1 (as $2 in $3): allowed"; else
    case "$out" in *"permission denied"*|*"must be owner"*|*"read-only transaction"*) ok "$1 (as $2 in $3): refused";; *) bad "$1 (as $2 in $3): failed for another reason: $(printf '%s' "$out" | tail -1)";; esac
  fi
}
expect_allowed() { # what, role, db, sql
  if out=$(psql_as "$2" "$3" "$4"); then ok "$1 (as $2 in $3)"; else bad "$1 (as $2 in $3): $(printf '%s' "$out" | tail -1)"; fi
}

sources=$(node -e '
const text = require("fs").readFileSync(process.argv[1], "utf8");
for (const block of text.split(/\n\s*- name:/).slice(1)) {
  if (!/\n\s*type:\s*postgres\b/.test(block)) continue;
  const user = (block.match(/\n\s*user:\s*(\S+)/) || [])[1] || "";
  const db = (block.match(/\n\s*database:\s*(\S+)/) || [])[1] || "";
  const uid = (block.match(/\n\s*uid:\s*(\S+)/) || [])[1] || "";
  console.log(user + " " + db + " " + uid);
}' "$(winpath "$ROOT/grafana/provisioning/datasources/datasources.yml")")

[ "$(printf '%s\n' "$sources" | grep -c .)" -ge 3 ] || bad "fewer than three Postgres data sources found"

while read -r role db _ <&3; do
  [ -n "$role" ] || continue
  echo "== data source role $role, database $db"
  if [ "$(super postgres "SELECT count(*) FROM pg_roles WHERE rolname = '$role'")" != "1" ]; then bad "no role $role"; continue; fi
  owner=$(super postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'")
  if [ "$owner" = "$role" ]; then bad "$role owns $db"; else ok "$role is not the owner of $db ($owner is)"; fi
  [ "$(super postgres "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = '$role'")" = "f" ] && ok "$role has no special attribute" || bad "$role has a special attribute"
  # A member of the owner (or of any role that can write) inherits its rights.
  [ "$(super postgres "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '$role'")" = "0" ] && ok "$role is a member of no other role" || bad "$role is a member of another role"

  case "$db" in
    dashboard) readable="repos repo_snapshots releases release_assets commit_snapshots loc_snapshots container_pull_snapshots"; written='UPDATE repos SET default_branch = default_branch'; secret='SELECT error FROM collector_runs';;
    telemetry) readable="heartbeats instance_meta expired_instances error_counts"; written="INSERT INTO expired_instances (day, count) VALUES ('2001-01-01', 1)"; secret='';;
    umami)     readable="website website_event session event_data"; written="UPDATE \"user\" SET password = 'x'"; secret='SELECT password FROM "user"';;
    warden)    readable="warden_runs"; written="UPDATE warden_runs SET reason = 'changed'"; secret='SELECT count(*) FROM warden_notes';;
    *)         readable=""; written='CREATE TABLE probe_w (n int)'; secret='';;
  esac
  for table in $readable; do expect_allowed "reads $table" "$role" "$db" "SELECT count(*) FROM $table"; done
  expect_refused "create a table" "$role" "$db" 'CREATE TABLE probe (note text)'
  expect_refused "create a table after switching read-only off in the session" "$role" "$db" 'SET default_transaction_read_only = off; SET transaction_read_only = off; CREATE TABLE probe (note text)'
  expect_refused "create a temporary table" "$role" "$db" 'CREATE TEMP TABLE probe_t (note text)'
  expect_refused "write to a table the apps own" "$role" "$db" "$written"
  expect_refused "create a function" "$role" "$db" "CREATE FUNCTION probe_f() RETURNS int LANGUAGE sql AS 'SELECT 1'"
  expect_refused "create a large object" "$role" "$db" "SELECT lo_from_bytea(0, 'x'::bytea)"
  [ -n "$secret" ] && expect_refused "read a column the dashboards do not show ($secret)" "$role" "$db" "$secret"
  [ "$db" = umami ] && expect_refused "read Umami's two-factor secrets" "$role" "$db" 'SELECT secret FROM two_factor_auth'
  for other in grafana umami dashboard telemetry warden postgres template1; do
    [ "$other" = "$db" ] && continue
    [ "$(super postgres "SELECT has_database_privilege('$role', '$other', 'CONNECT')")" = "f" ] && ok "$role cannot connect to $other" || bad "$role can connect to $other"
  done
  limit=$(super postgres "SELECT rolconnlimit FROM pg_roles WHERE rolname = '$role'")
  [ "$limit" != "-1" ] && ok "$role has a connection limit ($limit)" || bad "$role has no connection limit"
  timeout=$(super postgres "SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole, unnest(s.setconfig) c WHERE r.rolname = '$role' AND c LIKE 'statement_timeout=%'")
  [ "$timeout" != "0" ] && ok "$role has a statement timeout" || bad "$role has no statement timeout"
done 3<<EOF
$sources
EOF

# Tables the apps create after the grants ran, as a later version would: the collectors' new
# tables are readable, Umami's are not, and collector_runs stays closed when it is made again.
echo "== tables created after the grants"
psql_as dashboard dashboard 'CREATE TABLE later_snapshots (n int)' >/dev/null || bad "dashboard could not create a table"
psql_as telemetry telemetry 'CREATE TABLE later_rollups (n int)' >/dev/null || bad "telemetry could not create a table"
psql_as umami umami 'CREATE TABLE later_umami (n int)' >/dev/null || bad "umami could not create a table"
psql_as warden warden 'CREATE TABLE later_warden (n int)' >/dev/null || bad "warden could not create a table"
psql_as dashboard dashboard 'DROP TABLE collector_runs' >/dev/null || bad "dashboard could not drop collector_runs"
schema_as dashboard dashboard "$ROOT/collector/src/schema.sql" || bad "collector schema did not load again"
super dashboard "INSERT INTO collector_runs (job, error) VALUES ('git', 'text that may hold a credential')" >/dev/null
while read -r role db _ <&3; do
  case "$db" in
    dashboard)
      expect_allowed "reads a table the collector created later" "$role" "$db" 'SELECT count(*) FROM later_snapshots'
      expect_refused "read collector_runs after the collector made it again" "$role" "$db" 'SELECT error FROM collector_runs';;
    telemetry) expect_allowed "reads a table the collector created later" "$role" "$db" 'SELECT count(*) FROM later_rollups';;
    umami)     expect_refused "read a table Umami created later" "$role" "$db" 'SELECT count(*) FROM later_umami';;
    warden)    expect_refused "read a table the Warden bot created later" "$role" "$db" 'SELECT count(*) FROM later_warden';;
  esac
done 3<<EOF
$sources
EOF

grants() { docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < "$ROOT/postgres/grafana-read-only.sql" >/dev/null 2>"$ERR"; }
# The image trusts connections from 127.0.0.1; its own network address asks for the password.
ADDR=$(docker exec "$NAME" hostname -i | tr -d '\r' | cut -d' ' -f1)
login() { # role, database, password variable, sql: a real login over TCP, as Grafana logs in
  docker exec -e "PGPASSWORD=fake-$3" "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -h "$ADDR" -U "$1" -d "$2" -c "$4" 2>&1 </dev/null
}

echo "== what was left from before the grants"
expect_refused "write repos through a grant to PUBLIC made before the grants ran" grafana_dashboard_ro dashboard "UPDATE repos SET default_branch = 'changed'"
psql_as dashboard dashboard 'CREATE TABLE made_after_leftovers (n int)' >/dev/null
expect_refused "write a table made later, through default privileges for PUBLIC made before" grafana_dashboard_ro dashboard "INSERT INTO made_after_leftovers VALUES (1)"
for db in dashboard umami telemetry warden; do
  left=$(super "$db" "SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND a.grantee = 0)
    + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND a.grantee = 0
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
    + (SELECT count(*) FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'public' AND a.grantee = 0)
    + (SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = 0)")
  [ "$left" = 0 ] && ok "nothing in $db is granted to PUBLIC" || bad "$db grants PUBLIC something ($left)"
done
# A schema or a function that runs as its owner, which the apps don't make: the grants file stops and names it.
super dashboard "CREATE SCHEMA left_behind; GRANT USAGE ON SCHEMA left_behind TO PUBLIC;
  CREATE FUNCTION left_behind.run(text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN EXECUTE \$1; END'" >/dev/null
if grants; then bad "the grants file finished with a schema and an owner-rights function left in dashboard"; else
  case "$(cat "$ERR")" in *left_behind*"runs as its owner"*) ok "the grants file stops and names the schema and the function";; *) bad "the grants file failed for another reason: $(tail -1 "$ERR")";; esac
fi
super dashboard "DROP SCHEMA left_behind CASCADE" >/dev/null
super telemetry "CREATE FUNCTION public.as_owner() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'" >/dev/null
if grants; then bad "the grants file finished with an owner-rights function in telemetry's public schema"; else ok "the grants file stops on an owner-rights function in public"; fi
super telemetry "DROP FUNCTION public.as_owner()" >/dev/null
grants && ok "the grants file runs again once they are gone" || bad "the grants file fails on a clean database: $(tail -1 "$ERR")"

echo "== the Warden bot's own role keeps what it needs"
expect_allowed "the bot writes its ledger" warden warden "INSERT INTO warden_runs (platform, kind) VALUES ('discord', 'comment')"
expect_allowed "the bot runs its schema at start" warden warden "CREATE TABLE IF NOT EXISTS warden_runs (id bigserial PRIMARY KEY); CREATE INDEX IF NOT EXISTS warden_runs_ts ON warden_runs (ts)"
[ "$(docker exec -e PGPASSWORD=fake-warden "$NAME" psql -X -q -At -h "$ADDR" -U warden -d warden -c 'SELECT count(*) > 0 FROM warden_runs' 2>&1 </dev/null)" = t ] \
  && ok "the bot logs in to its database over TCP" || bad "the bot can't log in to its database"
[ "$(login grafana_warden_ro warden POSTGRES_GRAFANA_WARDEN_RO_PASSWORD 'SELECT count(*) > 0 FROM warden_runs')" = t ] \
  && ok "the Warden data source's login reads warden_runs over TCP" || bad "the Warden data source's login can't read warden_runs"

echo "== what the logins can change about themselves, and what each deploy puts back"
psql_as grafana_dashboard_ro dashboard "ALTER ROLE grafana_dashboard_ro SET search_path = 'nowhere'" >/dev/null && ok "a login may change its own settings (Postgres allows it; each deploy resets them)" || bad "self settings: unexpected"
expect_refused "change another login's settings" grafana_dashboard_ro dashboard "ALTER ROLE grafana_umami_ro SET search_path = 'nowhere'"
expect_refused "change an owner's password" grafana_dashboard_ro dashboard "ALTER ROLE dashboard PASSWORD 'fake-changed'"
expect_refused "make itself a superuser" grafana_dashboard_ro dashboard "ALTER ROLE grafana_dashboard_ro SUPERUSER"
expect_refused "lift its temp_file_limit for the session" grafana_dashboard_ro dashboard "SET temp_file_limit = -1"
expect_refused "lift its temp_file_limit for good" grafana_dashboard_ro dashboard "ALTER ROLE grafana_dashboard_ro RESET temp_file_limit"
psql_as grafana_dashboard_ro dashboard "ALTER ROLE grafana_dashboard_ro IN DATABASE dashboard SET work_mem = '4GB';
  ALTER ROLE grafana_dashboard_ro RESET statement_timeout; ALTER ROLE grafana_dashboard_ro PASSWORD 'fake-changed-by-itself'" >/dev/null
[ "$(login grafana_dashboard_ro dashboard POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD 'SELECT 1')" != 1 ] && ok "after changing its own password the data source can't log in (until the next deploy)" || bad "the changed password did not take"
grants || bad "the grants file failed: $(tail -1 "$ERR")"
settings=$(super postgres "SELECT coalesce(string_agg(coalesce(d.datname, '*') || ':' || array_to_string(s.setconfig, ','), ' '), '') FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase WHERE r.rolname = 'grafana_dashboard_ro'")
[ "$settings" = "*:statement_timeout=15s,temp_file_limit=100MB,idle_in_transaction_session_timeout=60s,default_transaction_read_only=on" ] \
  && ok "the grants file puts the login's settings back: $settings" || bad "the login's settings after the grants file: $settings"
[ "$(login grafana_dashboard_ro dashboard POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD 'SELECT current_user')" = grafana_dashboard_ro ] \
  && ok "the grants file puts the password from the environment back" || bad "the data source still can't log in"

echo "== the query watchdog"
[ "$(super postgres "SELECT has_database_privilege('grafana_query_watchdog', 'dashboard', 'CONNECT') OR has_database_privilege('grafana_query_watchdog', 'umami', 'CONNECT') OR has_database_privilege('grafana_query_watchdog', 'telemetry', 'CONNECT') OR has_database_privilege('grafana_query_watchdog', 'warden', 'CONNECT')")" = f ] \
  && ok "the watchdog connects to none of the apps' databases" || bad "the watchdog can connect to an app database"
docker exec -d -e PGPASSWORD=fake-POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD "$NAME" sh -c \
  "psql -X -h $ADDR -U grafana_dashboard_ro -d dashboard -c 'SET statement_timeout = 0' -c 'SELECT pg_sleep(60)' > /tmp/long-query.out 2>&1"
sleep 23
out=$(docker exec -i -e PGPASSWORD=fake-POSTGRES_QUERY_WATCHDOG_PASSWORD "$NAME" psql -X -q -At -F ' ' -v ON_ERROR_STOP=1 -h "$ADDR" -U grafana_query_watchdog -d postgres -f - < "$ROOT/postgres/watchdog/query-watchdog.sql" 2>&1)
[ "$out" = "1 0" ] && ok "the watchdog cancels a statement the login let run past 20 seconds" || bad "the watchdog answered: $out"
sleep 1
case "$(docker exec "$NAME" cat /tmp/long-query.out 2>&1)" in *"canceling statement due to user request"*) ok "the 60-second statement was cancelled";; *) bad "the long statement was not cancelled: $(docker exec "$NAME" cat /tmp/long-query.out 2>&1 | tail -1)";; esac
out=$(docker exec -i -e PGPASSWORD=fake-POSTGRES_QUERY_WATCHDOG_PASSWORD "$NAME" psql -X -q -At -F ' ' -h "$ADDR" -U grafana_query_watchdog -d postgres -f - < "$ROOT/postgres/watchdog/query-watchdog.sql" 2>&1)
[ "$out" = "0 0" ] && ok "nothing else is cancelled" || bad "the watchdog's second run answered: $out"

# Every panel and variable query of every dashboard, as its data source's role. Grafana's macros
# become fixed values. The telemetry tables get a few rows with versions as an older collector
# stored them, which every panel that sorts by version has to cope with; otherwise the tables are
# empty, so this checks rights and syntax, not results.
echo "== the dashboards' queries"
psql_as telemetry telemetry "INSERT INTO heartbeats (instance_id, day, payload)
    SELECT gen_random_uuid(), current_date, jsonb_build_object('version', v, 'platform', 'docker', 'build', 'release')
      FROM unnest(ARRAY['1.21.1', '1.21.0-beta.2', '1.20.0+desktop.abc1234', '99999999999.0.0', '1.2.99999999999']) v;
  INSERT INTO error_counts (instance_id, day, fingerprint, version, name, frames, count_bucket, days)
    SELECT gen_random_uuid(), current_date - 1, '0123456789abcdef', v, 'TypeError', '[]', '1', 1
      FROM unnest(ARRAY['1.21.1', '1.21.0-beta.2', '99999999999.0.0', '1.2.99999999999']) v" >/dev/null || bad "telemetry rows"
queries=$(node -e '
const fs = require("fs"), path = require("path");
const [dir, sourcesText] = process.argv.slice(1);
const byUid = new Map(sourcesText.trim().split("\n").map((l) => l.split(" ")).map(([role, db, uid]) => [uid, { role, db }]));
const from = "'"'"'2026-01-01T00:00:00Z'"'"'", to = "'"'"'2026-12-31T00:00:00Z'"'"'";
const fill = (sql) => sql
  .replace(/\$__timeFilter\(([^)]+)\)/g, (_, col) => `${col} BETWEEN ${from} AND ${to}`)
  .replace(/\$__timeFrom\(\)/g, from)
  .replace(/\$__timeTo\(\)/g, to)
  .replace(/\$__timeGroupAlias\(([^,]+),[^)]*\)/g, (_, col) => `to_timestamp(floor(extract(epoch FROM ${col}) / 86400) * 86400) AS "time"`)
  .replace(/\$__timeGroup\(([^,]+),[^)]*\)/g, (_, col) => `to_timestamp(floor(extract(epoch FROM ${col}) / 3600) * 3600)`)
  .replace(/\$\{?repo\}?/g, "bulwarkmail/webmail")
  .replace(/\$\{?site\}?/g, "00000000-0000-0000-0000-000000000000");
const out = [];
function walk(node, uid, file, title) {
  if (Array.isArray(node)) { for (const n of node) walk(n, uid, file, title); return; }
  if (!node || typeof node !== "object") return;
  if (node.datasource && typeof node.datasource === "object" && node.datasource.uid) uid = node.datasource.uid;
  if (typeof node.title === "string") title = node.title;
  const sql = typeof node.rawSql === "string" ? node.rawSql : (typeof node.query === "string" && node.type === "query" ? node.query : null);
  if (sql && byUid.has(uid)) {
    const { role, db } = byUid.get(uid);
    const label = typeof node.rawSql === "string" ? title : `variable ${node.name}`;
    out.push([role, db, Buffer.from(`${file}: ${label}`).toString("base64"), Buffer.from(fill(sql)).toString("base64")].join("\t"));
  }
  for (const [k, v] of Object.entries(node)) if (k !== "datasource") walk(v, uid, file, title);
}
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) walk(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), undefined, f, undefined);
console.log(out.join("\n"));
' "$(winpath "$ROOT/grafana/dashboards")" "$sources")
count=0
while IFS=$'\t' read -r role db label sql <&3; do
  [ -n "$role" ] || continue
  count=$((count + 1))
  label=$(printf '%s' "$label" | base64 -d)
  if out=$(printf '%s' "$sql" | base64 -d | docker exec -i "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "SET ROLE \"$role\"" -f - 2>&1); then
    ok "$label (as $role)"
  else
    bad "$label (as $role): $(printf '%s' "$out" | tail -1)"
  fi
done 3<<EOF
$queries
EOF
[ "$count" -ge 20 ] && ok "ran $count dashboard queries" || bad "found only $count dashboard queries"

echo
[ "$fail" = 0 ] && echo "all ok" || echo "FAILED"
exit "$fail"
