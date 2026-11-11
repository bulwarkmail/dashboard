#!/usr/bin/env bash
# Idempotent deploy / redeploy. Run from $APP_DIR on the server.
# First run: generates .env, installs nginx vhosts + certs, starts compose.
# Subsequent runs: pulls compose images, applies config, restarts services.
#
# All site-specific values (domains, email, install path) come from .env.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
NGINX_SITES_AVAIL="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
HTPASSWD_DIR="/etc/nginx/htpasswd"
CERTBOT_WEBROOT="/var/www/certbot"

cd "$APP_DIR"

log() { printf "==> %s\n" "$*"; }
die() { printf "ERROR: %s\n" "$*" >&2; exit 1; }

rand() { openssl rand -hex 32; }

# Credentials for curl go through files in this private folder, never on
# curl's command line, which every local account can read in the process list.
CRED_DIR=$(mktemp -d)
trap 'rm -rf "$CRED_DIR"' EXIT

# Give NAME a fresh secret in .env when it is missing or empty; a value that
# is set is never changed. Only shell builtins handle the value, so it never
# shows up in the process list.
ensure_secret() {
  local name="$1" line value tmp found=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$name="?*) return 0 ;; esac
  done < .env
  value=$(rand)
  tmp=$(mktemp "$APP_DIR/.env.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$name=" ]; then
      printf '%s=%s\n' "$name" "$value"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done < .env > "$tmp"
  [ "$found" = 1 ] || printf '%s=%s\n' "$name" "$value" >> "$tmp"
  # Rewrite in place, so .env keeps its owner and mode.
  cat "$tmp" > .env
  rm -f "$tmp"
  log "Generated $name in .env"
}

# --- 1. .env ---------------------------------------------------------------
FIRST_RUN=0
if [ ! -f .env ]; then
  log "Generating .env with fresh secrets — fill in domain/email values before re-running"
  FIRST_RUN=1
  cp .env.example .env
  chmod 600 .env
  for name in POSTGRES_PASSWORD POSTGRES_GRAFANA_PASSWORD POSTGRES_UMAMI_PASSWORD POSTGRES_DASHBOARD_PASSWORD \
              POSTGRES_TELEMETRY_PASSWORD GRAFANA_ADMIN_PASSWORD UMAMI_APP_SECRET; do
    ensure_secret "$name"
  done
fi
# Secrets added after the first release: generated in an existing .env too.
for name in POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD POSTGRES_GRAFANA_UMAMI_RO_PASSWORD POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD \
            POSTGRES_QUERY_WATCHDOG_PASSWORD UMAMI_ADMIN_PASSWORD; do
  ensure_secret "$name"
done
if [ "$FIRST_RUN" = 1 ]; then
  log "Wrote .env. Edit GRAFANA_DOMAIN / UMAMI_DOMAIN / TELEMETRY_DOMAIN / VERSION_DOMAIN / LE_EMAIL, then re-run."
  exit 0
fi
# Read, not exported: nothing this script starts gets the secrets through its
# environment. docker compose reads .env itself, the apps read it themselves,
# render_vhost passes each template only the values it names.
. ./.env

# Required from .env (no defaults — these are site-specific).
: "${GRAFANA_DOMAIN:?set GRAFANA_DOMAIN in .env}"
: "${GRAFANA_PUBLIC_DOMAIN:?set GRAFANA_PUBLIC_DOMAIN in .env}"
: "${UMAMI_DOMAIN:?set UMAMI_DOMAIN in .env}"
: "${TELEMETRY_DOMAIN:?set TELEMETRY_DOMAIN in .env}"
: "${VERSION_DOMAIN:?set VERSION_DOMAIN in .env}"
: "${LE_EMAIL:?set LE_EMAIL in .env, used for Lets Encrypt registration}"
: "${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD in .env}"
: "${GRAFANA_ADMIN_USER:=admin}"
# GRAFANA_PUBLIC_DASHBOARD_TOKEN is captured below from the Grafana API on
# first deploy and written back to .env. Default to a stub so envsubst
# doesn't blank the redirect target before bootstrap finishes.
: "${GRAFANA_PUBLIC_DASHBOARD_TOKEN:=pending}"
# Umami's vhost serves only the tracker until step 9a has made sure Umami's
# default login is gone. (render_vhost reads it by name.)
# shellcheck disable=SC2034
UMAMI_APP_OPEN=no

command -v envsubst >/dev/null || die "envsubst not found — install gettext-base"

# --- 2. data dirs ----------------------------------------------------------
mkdir -p data/postgres data/prometheus data/grafana data/repos
# Grafana container runs as uid 472, prometheus as 65534.
chown -R 472:472   data/grafana
chown -R 65534:65534 data/prometheus

# The relay's metrics token, which Prometheus sends on the relay job. Without
# the file, docker would mount an empty folder in its place; an empty file
# just fails that one scrape until the token is put in.
mkdir -p secrets
chmod 750 secrets
if [ ! -f secrets/relay-metrics-token ]; then
  log "WARN: secrets/relay-metrics-token is missing; put the relay's metrics token in it, Prometheus can't scrape the relay until then"
  : > secrets/relay-metrics-token
fi
# Readable by Prometheus (uid 65534) only.
chown 65534:65534 secrets/relay-metrics-token
chmod 400 secrets/relay-metrics-token

# --- 3. nginx vhosts -------------------------------------------------------
# Drop any leftover htpasswd from older deploys — internal Grafana now
# sits behind Grafana's own login, no nginx basic auth.
rm -f "$HTPASSWD_DIR/grafana"

# Render template → /etc/nginx/sites-available/<domain>. Pass the names of
# every variable that should be substituted; everything else (including
# nginx's own $host / $remote_addr) is left literal.
render_vhost() {
  local template="$1" domain="$2"; shift 2
  local vars="" values=()
  for v in "$@"; do vars="$vars \${$v}"; values+=("$v=${!v}"); done
  log "Rendering nginx vhost: $domain"
  env -i PATH="$PATH" "${values[@]}" envsubst "$vars" < "$APP_DIR/nginx/$template" > "$NGINX_SITES_AVAIL/$domain"
  ln -sf "$NGINX_SITES_AVAIL/$domain" "$NGINX_SITES_ENABLED/$domain"
}

# Issue cert if missing - needs an HTTP-only stub so certbot can answer the challenge.
ensure_cert() {
  local name="$1"
  if [ -d "/etc/letsencrypt/live/$name" ]; then
    log "Cert already exists for $name"
    return 0
  fi
  log "Requesting cert for $name"
  cat > "$NGINX_SITES_AVAIL/$name.stub" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $name;
    location /.well-known/acme-challenge/ { root $CERTBOT_WEBROOT; }
    location / { return 404; }
}
EOF
  ln -sf "$NGINX_SITES_AVAIL/$name.stub" "$NGINX_SITES_ENABLED/$name"
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w "$CERTBOT_WEBROOT" -d "$name" \
    --non-interactive --agree-tos -m "$LE_EMAIL"
  rm -f "$NGINX_SITES_ENABLED/$name" "$NGINX_SITES_AVAIL/$name.stub"
}

ensure_cert "$GRAFANA_DOMAIN"
ensure_cert "$GRAFANA_PUBLIC_DOMAIN"
ensure_cert "$UMAMI_DOMAIN"
ensure_cert "$TELEMETRY_DOMAIN"
ensure_cert "$VERSION_DOMAIN"

render_vhost grafana.conf.template        "$GRAFANA_DOMAIN"        GRAFANA_DOMAIN
render_vhost grafana-public.conf.template "$GRAFANA_PUBLIC_DOMAIN" GRAFANA_PUBLIC_DOMAIN GRAFANA_PUBLIC_DASHBOARD_TOKEN
render_vhost umami.conf.template          "$UMAMI_DOMAIN"          UMAMI_DOMAIN UMAMI_APP_OPEN
render_vhost telemetry.conf.template      "$TELEMETRY_DOMAIN"      TELEMETRY_DOMAIN
render_vhost version.conf.template        "$VERSION_DOMAIN"        VERSION_DOMAIN

log "Validating nginx config"
nginx -t
systemctl reload nginx

# --- 4. docker compose -----------------------------------------------------
log "Pulling images"
docker compose pull
log "Starting stack"
docker compose up -d
log "Waiting for postgres..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    log "Postgres ready"
    break
  fi
  sleep 2
done

# Grafana's read-only database logins (postgres/grafana-read-only.sql): the
# roles, their passwords and settings from .env, what they may read. Applied
# as soon as Postgres is up, so Grafana's data sources work while the builds
# run, and again in step 8c, once Umami has made its tables.
apply_grafana_logins() {
  log "Applying Grafana's read-only database logins"
  docker compose exec -T postgres psql -X -q -U postgres -d postgres < "$APP_DIR/postgres/grafana-read-only.sql"
}
apply_grafana_logins

# --- 5. shared docker network for cross-stack scraping --------------------
docker network inspect bulwark >/dev/null 2>&1 || docker network create bulwark

# --- 6. scc (LOC counter) --------------------------------------------------
if ! command -v scc >/dev/null 2>&1; then
  log "Installing scc"
  SCC_VERSION=3.5.0
  # scc_Linux_x86_64.tar.gz of v3.5.0, from the release's checksums.txt.
  SCC_SHA256=6c31f4d0cf3b7a8c5ca910fa4e451949434798f6541ec5dea4b83f4973e13772
  TMP=$(mktemp -d)
  curl -sSfL "https://github.com/boyter/scc/releases/download/v${SCC_VERSION}/scc_Linux_x86_64.tar.gz" -o "$TMP/scc.tgz"
  printf '%s  %s\n' "$SCC_SHA256" "$TMP/scc.tgz" | sha256sum -c --quiet - || die "the scc download doesn't match its pinned sha256"
  tar -xzf "$TMP/scc.tgz" -C "$TMP"
  install -m 0755 "$TMP/scc" /usr/local/bin/scc
  rm -rf "$TMP"
fi

# --- 6b. the collector's own account --------------------------------------
# The GitHub collector clones and unpacks repositories. It runs as the system
# account bulwark-collector (uid/gid in collector/ecosystem.config.cjs), which
# owns the clones in data/repos and nothing else of the stack. It reads its
# own variables from collector/.env and the App Store Connect key through
# their group, which has no other member; other accounts can't read them.
# All of this happens before the collector is started below.
if ! id -u bulwark-collector >/dev/null 2>&1; then
  log "Creating the system account bulwark-collector"
  useradd --system --user-group --home-dir "$APP_DIR/data/repos" --no-create-home \
    --shell /usr/sbin/nologin bulwark-collector
fi
chown -R bulwark-collector:bulwark-collector data/repos
chmod 700 data/repos
# The collector's variables only: its token, its database password, its settings.
(umask 077; grep -E '^(GITHUB_TOKEN|GITHUB_ORG|POSTGRES_DASHBOARD_PASSWORD|PG_HOST|PG_PORT|PG_USER|PG_DATABASE|GHCR_PACKAGES|COLLECTOR_[A-Z0-9_]+|ASC_[A-Z0-9_]+)=' .env > collector/.env.new || true)
chgrp bulwark-collector collector/.env.new
chmod 640 collector/.env.new
mv -f collector/.env.new collector/.env
# Until the collector reads collector/.env (collector/src/env.ts), it reads the
# stack's .env, which then has to stay readable for its group.
if grep -qF "path.resolve(here, '..', '.env')" collector/src/env.ts; then
  chgrp root .env
  chmod 600 .env
else
  log "WARN: the collector still reads the stack's .env; it stays readable for the bulwark-collector group"
  chgrp bulwark-collector .env
  chmod 640 .env
fi
chgrp bulwark-collector secrets
if [ -n "${ASC_KEY_FILE:-}" ]; then
  # Relative to the collector's folder, where pm2 starts it.
  case "$ASC_KEY_FILE" in /*) asc_key="$ASC_KEY_FILE" ;; *) asc_key="$APP_DIR/collector/$ASC_KEY_FILE" ;; esac
  if [ -f "$asc_key" ]; then
    chgrp bulwark-collector "$asc_key"
    chmod 640 "$asc_key"
  fi
fi
# pm2 writes the collector's log files; the folder stays root's, as the
# other services log there too.
mkdir -p /var/log/bulwark-dashboard
for f in collector.out.log collector.err.log; do
  touch "/var/log/bulwark-dashboard/$f"
  chown bulwark-collector:bulwark-collector "/var/log/bulwark-dashboard/$f"
  chmod 640 "/var/log/bulwark-dashboard/$f"
done

# pm2 hands an app the environment of the shell that starts it and writes it
# into its saved process list. The apps read their .env themselves, so pm2 is
# called with PATH and HOME only (HOME: the app's account's home).
PM2_DIR="${PM2_HOME:-$HOME/.pm2}"
pm2_clean() { # home, pm2 arguments...
  local home="$1"; shift
  env -i PATH="$PATH" HOME="$home" PM2_HOME="$PM2_DIR" pm2 "$@"
}

# Whether a running app has to be started anew rather than reloaded: pm2 keeps
# a process's environment and account across reloads, so a process that still
# carries a variable named in .env, or runs as another account than its
# ecosystem file names, is deleted and started once. Only names are compared;
# no value is printed.
needs_new_start() { # name, account the ecosystem file names (may be empty)
  local name="$1" want="$2" pid uid=""
  if pm2_clean "$HOME" jlist 2>/dev/null | node -e '
      const keys = new Set(require("fs").readFileSync(process.argv[1], "utf8").split("\n")
        .map((line) => (/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line) || [])[1]).filter(Boolean));
      let s = "";
      process.stdin.on("data", (d) => { s += d; }).on("end", () => {
        const apps = JSON.parse(s.slice(s.indexOf("[")));
        const app = apps.find((a) => a.name === process.argv[2]);
        const env = app ? { ...(app.pm2_env || {}), ...((app.pm2_env && app.pm2_env.env) || {}) } : {};
        process.exit(Object.keys(env).some((k) => keys.has(k)) ? 0 : 1);
      });' "$APP_DIR/.env" "$name"; then
    return 0
  fi
  [ -n "$want" ] || return 1
  pid=$(pm2_clean "$HOME" pid "$name" 2>/dev/null || true)
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then uid=$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ' || true); fi
  [ "$uid" != "$(id -u "$want")" ]
}

# Build one package and start or reload its pm2 app.
deploy_app() { # folder, pm2 name, home of its account
  local dir="$APP_DIR/$1" name="$2" home="$3" eco want
  eco="$dir/ecosystem.config.cjs"
  [ -d "$dir" ] || return 0
  log "Building $1"
  mkdir -p /var/log/bulwark-dashboard
  pushd "$dir" >/dev/null
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  npm run build
  popd >/dev/null
  want=$(node -e 'process.stdout.write(String(require(process.argv[1]).apps[0].uid || ""))' "$eco")
  if pm2_clean "$home" describe "$name" >/dev/null 2>&1; then
    if needs_new_start "$name" "$want"; then
      log "Starting $name anew${want:+ as $want}, with no variables from .env"
      pm2_clean "$home" delete "$name"
      pm2_clean "$home" start "$eco"
    else
      log "Reloading $name"
      pm2_clean "$home" reload "$eco" --update-env
    fi
  else
    log "Starting $name"
    pm2_clean "$home" start "$eco"
  fi
}

# --- 7. collector (pm2) ----------------------------------------------------
deploy_app collector bulwark-dashboard-collector "$APP_DIR/data/repos"

# --- 8. telemetry-collector (pm2) -----------------------------------------
deploy_app telemetry-collector bulwark-telemetry-collector "$HOME"

# --- 8b. version-server (pm2) ---------------------------------------------
deploy_app version-server bulwark-version-server "$HOME"

# The saved process list (twice, so the backup copy is the new list too),
# readable by root only.
pm2_clean "$HOME" save --force >/dev/null
pm2_clean "$HOME" save --force >/dev/null
chmod 700 "$PM2_DIR"
for f in "$PM2_DIR"/dump.pm2*; do
  if [ -e "$f" ]; then chmod 600 "$f"; fi
done

# --- 8c. Grafana's read-only database logins, again ------------------------
# Umami creates its tables on its first start; wait for them, so the tables
# the dashboards read get their grant in this run.
for i in {1..60}; do
  if [ "$(docker compose exec -T postgres psql -X -At -U postgres -d umami -c "SELECT to_regclass('public.website_event') IS NOT NULL" 2>/dev/null)" = "t" ]; then break; fi
  sleep 2
done
apply_grafana_logins

# --- 9a. Umami: replace the default login ---------------------------------
# Umami creates the account admin with a well-known password on its first
# start. Replace it with UMAMI_ADMIN_PASSWORD through Umami's own API; until
# that is done, or when Umami doesn't answer, the vhost serves only the
# tracker script and /api/send. A password changed by hand stays as it is.
UMAMI_BASE="http://127.0.0.1:3007"

# Log in as admin with the password in $1. Prints the session token and
# returns 0 when logged in, 2 when Umami refused the password, 1 otherwise.
umami_login() {
  local status token
  printf '{"username":"admin","password":"%s"}' "$1" > "$CRED_DIR/umami-login.json"
  status=$(curl -s -o "$CRED_DIR/umami-login.out" -w '%{http_code}' -H 'content-type: application/json' \
    --data-binary @"$CRED_DIR/umami-login.json" "$UMAMI_BASE/api/auth/login") || return 1
  [ "$status" = 401 ] && return 2
  [ "$status" = 200 ] || return 1
  token=$(grep -oE '"token":"[^"]+"' "$CRED_DIR/umami-login.out" | head -1 | sed -e 's/^"token":"//' -e 's/"$//') || return 1
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

secure_umami() {
  local token rc=0
  for i in {1..60}; do
    if curl -sf "$UMAMI_BASE/api/heartbeat" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  umami_login "$UMAMI_ADMIN_PASSWORD" >/dev/null && return 0
  token=$(umami_login umami) || rc=$?
  # Umami refuses its default password: it was changed by hand.
  [ "$rc" = 2 ] && return 0
  [ "$rc" = 0 ] || return 1
  log "Replacing Umami's default login with UMAMI_ADMIN_PASSWORD"
  printf '{"currentPassword":"umami","newPassword":"%s"}' "$UMAMI_ADMIN_PASSWORD" > "$CRED_DIR/umami-password.json"
  printf 'Authorization: Bearer %s\n' "$token" > "$CRED_DIR/umami-auth"
  curl -sf -H 'content-type: application/json' -H @"$CRED_DIR/umami-auth" \
    --data-binary @"$CRED_DIR/umami-password.json" "$UMAMI_BASE/api/me/password" >/dev/null || return 1
  umami_login "$UMAMI_ADMIN_PASSWORD" >/dev/null
}

if secure_umami; then
  # shellcheck disable=SC2034
  UMAMI_APP_OPEN=yes
  render_vhost umami.conf.template "$UMAMI_DOMAIN" UMAMI_DOMAIN UMAMI_APP_OPEN
  nginx -t && systemctl reload nginx
else
  log "WARN: Umami didn't answer, or its default login couldn't be replaced; $UMAMI_DOMAIN serves only the tracker until the next deploy"
fi

# --- 9. Bootstrap public-dashboard share token ----------------------------
# Wait for Grafana to come up, then ensure the "bulwark-public" dashboard
# has a public share enabled and capture its access token. Writes the token
# back into .env and re-renders the public vhost so the redirect points at
# the right URL.
bootstrap_public_share() {
  local uid="bulwark-public"
  local base="http://127.0.0.1:3006"
  # The admin's login, for curl --netrc-file.
  local netrc="$CRED_DIR/grafana.netrc"
  printf 'machine 127.0.0.1 login %s password %s\n' "$GRAFANA_ADMIN_USER" "$GRAFANA_ADMIN_PASSWORD" > "$netrc"

  # Wait for Grafana itself.
  for i in {1..30}; do
    if curl -sf --netrc-file "$netrc" "$base/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  # Wait for the bulwark-public dashboard to be picked up by the file
  # provisioner (default scan interval is 30s).
  for i in {1..20}; do
    if curl -sf --netrc-file "$netrc" "$base/api/dashboards/uid/$uid" >/dev/null 2>&1; then break; fi
    sleep 3
  done
  if ! curl -sf --netrc-file "$netrc" "$base/api/dashboards/uid/$uid" >/dev/null 2>&1; then
    log "Public dashboard '$uid' not provisioned after 60s — skipping share bootstrap"
    return 0
  fi

  local existing token=""
  existing=$(curl -sf --netrc-file "$netrc" "$base/api/dashboards/uid/$uid/public-dashboards" 2>/dev/null || true)
  token=$(printf '%s' "$existing" | grep -oE '"accessToken":"[^"]+"' | head -1 | sed -e 's/.*:"//' -e 's/".*//')

  if [ -z "$token" ]; then
    log "Creating public share for dashboard '$uid'"
    local created
    created=$(curl -sf --netrc-file "$netrc" -X POST -H "content-type: application/json" \
      -d '{"isEnabled":true,"annotationsEnabled":false,"timeSelectionEnabled":false}' \
      "$base/api/dashboards/uid/$uid/public-dashboards" || true)
    token=$(printf '%s' "$created" | grep -oE '"accessToken":"[^"]+"' | head -1 | sed -e 's/.*:"//' -e 's/".*//')
  fi

  if [ -z "$token" ]; then
    log "WARN: could not obtain public-dashboard token; redirect on $GRAFANA_PUBLIC_DOMAIN will 404 until next deploy"
    return 0
  fi

  if ! grep -qE "^GRAFANA_PUBLIC_DASHBOARD_TOKEN=" .env; then
    echo "GRAFANA_PUBLIC_DASHBOARD_TOKEN=$token" >> .env
  else
    sed -i "s|^GRAFANA_PUBLIC_DASHBOARD_TOKEN=.*|GRAFANA_PUBLIC_DASHBOARD_TOKEN=$token|" .env
  fi
  GRAFANA_PUBLIC_DASHBOARD_TOKEN="$token"

  render_vhost grafana-public.conf.template "$GRAFANA_PUBLIC_DOMAIN" GRAFANA_PUBLIC_DOMAIN GRAFANA_PUBLIC_DASHBOARD_TOKEN
  nginx -t && systemctl reload nginx
  log "Public dashboard token: $token"
}
bootstrap_public_share

log "Done."
log "Grafana (admin): https://$GRAFANA_DOMAIN  (Grafana login)"
log "Public stats:    https://$GRAFANA_PUBLIC_DOMAIN  (no auth)"
log "Umami:           https://$UMAMI_DOMAIN     (login admin, password UMAMI_ADMIN_PASSWORD in .env unless changed by hand)"
log "Version server:  https://$VERSION_DOMAIN/?v=1.0.0"
