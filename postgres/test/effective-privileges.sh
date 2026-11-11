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
  for other in grafana umami dashboard telemetry postgres template1; do
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
  esac
done 3<<EOF
$sources
EOF

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
