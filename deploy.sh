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
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|"                       .env
  sed -i "s|^POSTGRES_GRAFANA_PASSWORD=.*|POSTGRES_GRAFANA_PASSWORD=$(rand)|"       .env
  sed -i "s|^POSTGRES_UMAMI_PASSWORD=.*|POSTGRES_UMAMI_PASSWORD=$(rand)|"           .env
  sed -i "s|^POSTGRES_DASHBOARD_PASSWORD=.*|POSTGRES_DASHBOARD_PASSWORD=$(rand)|"   .env
  sed -i "s|^POSTGRES_TELEMETRY_PASSWORD=.*|POSTGRES_TELEMETRY_PASSWORD=$(rand)|"   .env
  sed -i "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(rand)|"             .env
  sed -i "s|^UMAMI_APP_SECRET=.*|UMAMI_APP_SECRET=$(rand)|"                         .env
fi
# Secrets added after the first release: generated in an existing .env too.
for name in POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD POSTGRES_GRAFANA_UMAMI_RO_PASSWORD POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD; do
  ensure_secret "$name"
done
if [ "$FIRST_RUN" = 1 ]; then
  log "Wrote .env. Edit GRAFANA_DOMAIN / UMAMI_DOMAIN / TELEMETRY_DOMAIN / VERSION_DOMAIN / LE_EMAIL, then re-run."
  exit 0
fi
set -a; . ./.env; set +a

# Required from .env (no defaults — these are site-specific).
: "${GRAFANA_DOMAIN:?set GRAFANA_DOMAIN in .env}"
: "${GRAFANA_PUBLIC_DOMAIN:?set GRAFANA_PUBLIC_DOMAIN in .env}"
: "${UMAMI_DOMAIN:?set UMAMI_DOMAIN in .env}"
: "${TELEMETRY_DOMAIN:?set TELEMETRY_DOMAIN in .env}"
: "${VERSION_DOMAIN:?set VERSION_DOMAIN in .env}"
: "${LE_EMAIL:?set LE_EMAIL in .env, used for Lets Encrypt registration}"
: "${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD in .env}"
# GRAFANA_PUBLIC_DASHBOARD_TOKEN is captured below from the Grafana API on
# first deploy and written back to .env. Default to a stub so envsubst
# doesn't blank the redirect target before bootstrap finishes.
: "${GRAFANA_PUBLIC_DASHBOARD_TOKEN:=pending}"

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
  local vars=""
  for v in "$@"; do vars="$vars \${$v}"; done
  log "Rendering nginx vhost: $domain"
  envsubst "$vars" < "$APP_DIR/nginx/$template" > "$NGINX_SITES_AVAIL/$domain"
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
render_vhost umami.conf.template          "$UMAMI_DOMAIN"          UMAMI_DOMAIN
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

# --- 5. shared docker network for cross-stack scraping --------------------
docker network inspect bulwark >/dev/null 2>&1 || docker network create bulwark

# --- 6. scc (LOC counter) --------------------------------------------------
if ! command -v scc >/dev/null 2>&1; then
  log "Installing scc"
  SCC_VERSION=3.5.0
  TMP=$(mktemp -d)
  curl -sSL "https://github.com/boyter/scc/releases/download/v${SCC_VERSION}/scc_Linux_x86_64.tar.gz" -o "$TMP/scc.tgz"
  tar -xzf "$TMP/scc.tgz" -C "$TMP"
  install -m 0755 "$TMP/scc" /usr/local/bin/scc
  rm -rf "$TMP"
fi

# --- 7. collector (pm2) ----------------------------------------------------
if [ -d "$APP_DIR/collector" ]; then
  log "Building collector"
  mkdir -p /var/log/bulwark-dashboard
  pushd "$APP_DIR/collector" >/dev/null
  npm ci --no-audit --no-fund
  npm run build
  popd >/dev/null
  if pm2 describe bulwark-dashboard-collector >/dev/null 2>&1; then
    log "Reloading collector"
    pm2 reload "$APP_DIR/collector/ecosystem.config.cjs" --update-env
  else
    log "Starting collector"
    pm2 start "$APP_DIR/collector/ecosystem.config.cjs"
    pm2 save
  fi
fi

# --- 8. telemetry-collector (pm2) -----------------------------------------
if [ -d "$APP_DIR/telemetry-collector" ]; then
  log "Building telemetry-collector"
  mkdir -p /var/log/bulwark-dashboard
  pushd "$APP_DIR/telemetry-collector" >/dev/null
  npm ci --no-audit --no-fund
  npm run build
  popd >/dev/null
  if pm2 describe bulwark-telemetry-collector >/dev/null 2>&1; then
    log "Reloading telemetry-collector"
    pm2 reload "$APP_DIR/telemetry-collector/ecosystem.config.cjs" --update-env
  else
    log "Starting telemetry-collector"
    pm2 start "$APP_DIR/telemetry-collector/ecosystem.config.cjs"
    pm2 save
  fi
fi

# --- 8b. version-server (pm2) ---------------------------------------------
if [ -d "$APP_DIR/version-server" ]; then
  log "Building version-server"
  mkdir -p /var/log/bulwark-dashboard
  pushd "$APP_DIR/version-server" >/dev/null
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  npm run build
  popd >/dev/null
  if pm2 describe bulwark-version-server >/dev/null 2>&1; then
    log "Reloading version-server"
    pm2 reload "$APP_DIR/version-server/ecosystem.config.cjs" --update-env
  else
    log "Starting version-server"
    pm2 start "$APP_DIR/version-server/ecosystem.config.cjs"
    pm2 save
  fi
fi

# --- 8c. Grafana's read-only database logins ------------------------------
# On every deploy: the three roles Grafana's data sources log in with, their
# passwords from .env and what they may read (postgres/grafana-read-only.sql).
# Umami creates its tables on its first start; wait for them, so the tables
# the dashboards read get their grant in this run.
for i in {1..60}; do
  if [ "$(docker compose exec -T postgres psql -X -At -U postgres -d umami -c "SELECT to_regclass('public.website_event') IS NOT NULL" 2>/dev/null)" = "t" ]; then break; fi
  sleep 2
done
log "Applying Grafana's read-only database logins"
docker compose exec -T postgres psql -X -q -U postgres -d postgres < "$APP_DIR/postgres/grafana-read-only.sql"

# --- 9. Bootstrap public-dashboard share token ----------------------------
# Wait for Grafana to come up, then ensure the "bulwark-public" dashboard
# has a public share enabled and capture its access token. Writes the token
# back into .env and re-renders the public vhost so the redirect points at
# the right URL.
bootstrap_public_share() {
  local uid="bulwark-public"
  local base="http://127.0.0.1:3006"
  local auth="admin:$GRAFANA_ADMIN_PASSWORD"

  # Wait for Grafana itself.
  for i in {1..30}; do
    if curl -sf -u "$auth" "$base/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  # Wait for the bulwark-public dashboard to be picked up by the file
  # provisioner (default scan interval is 30s).
  for i in {1..20}; do
    if curl -sf -u "$auth" "$base/api/dashboards/uid/$uid" >/dev/null 2>&1; then break; fi
    sleep 3
  done
  if ! curl -sf -u "$auth" "$base/api/dashboards/uid/$uid" >/dev/null 2>&1; then
    log "Public dashboard '$uid' not provisioned after 60s — skipping share bootstrap"
    return 0
  fi

  local existing token=""
  existing=$(curl -sf -u "$auth" "$base/api/dashboards/uid/$uid/public-dashboards" 2>/dev/null || true)
  token=$(printf '%s' "$existing" | grep -oE '"accessToken":"[^"]+"' | head -1 | sed -e 's/.*:"//' -e 's/".*//')

  if [ -z "$token" ]; then
    log "Creating public share for dashboard '$uid'"
    local created
    created=$(curl -sf -u "$auth" -X POST -H "content-type: application/json" \
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
log "Umami:           https://$UMAMI_DOMAIN     (first-run admin / umami)"
log "Version server:  https://$VERSION_DOMAIN/?v=1.0.0"
