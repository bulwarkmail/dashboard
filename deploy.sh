#!/usr/bin/env bash
# Idempotent deploy / redeploy. Run from $APP_DIR on the server.
# First run: generates .env, installs nginx vhosts + certs + htpasswd, starts compose.
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

# --- 1. .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  log "Generating .env with fresh secrets — fill in domain/email values before re-running"
  cp .env.example .env
  chmod 600 .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|"                       .env
  sed -i "s|^POSTGRES_GRAFANA_PASSWORD=.*|POSTGRES_GRAFANA_PASSWORD=$(rand)|"       .env
  sed -i "s|^POSTGRES_UMAMI_PASSWORD=.*|POSTGRES_UMAMI_PASSWORD=$(rand)|"           .env
  sed -i "s|^POSTGRES_DASHBOARD_PASSWORD=.*|POSTGRES_DASHBOARD_PASSWORD=$(rand)|"   .env
  sed -i "s|^POSTGRES_TELEMETRY_PASSWORD=.*|POSTGRES_TELEMETRY_PASSWORD=$(rand)|"   .env
  sed -i "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(rand)|"             .env
  sed -i "s|^UMAMI_APP_SECRET=.*|UMAMI_APP_SECRET=$(rand)|"                         .env
  sed -i "s|^BASIC_AUTH_PASSWORD=.*|BASIC_AUTH_PASSWORD=$(rand)|"                   .env
  log "Wrote .env. Edit GRAFANA_DOMAIN / UMAMI_DOMAIN / TELEMETRY_DOMAIN / LE_EMAIL, then re-run."
  exit 0
fi
set -a; . ./.env; set +a

# Required from .env (no defaults — these are site-specific).
: "${GRAFANA_DOMAIN:?set GRAFANA_DOMAIN in .env}"
: "${UMAMI_DOMAIN:?set UMAMI_DOMAIN in .env}"
: "${TELEMETRY_DOMAIN:?set TELEMETRY_DOMAIN in .env}"
: "${LE_EMAIL:?set LE_EMAIL in .env (used for Let's Encrypt registration)}"
: "${BASIC_AUTH_USER:?set BASIC_AUTH_USER in .env}"
: "${BASIC_AUTH_PASSWORD:?set BASIC_AUTH_PASSWORD in .env}"

command -v envsubst >/dev/null || die "envsubst not found — install gettext-base"

# --- 2. data dirs ----------------------------------------------------------
mkdir -p data/postgres data/prometheus data/grafana data/repos
# Grafana container runs as uid 472, prometheus as 65534.
chown -R 472:472   data/grafana
chown -R 65534:65534 data/prometheus

# --- 3. nginx vhosts -------------------------------------------------------
mkdir -p "$HTPASSWD_DIR"
if [ ! -f "$HTPASSWD_DIR/grafana" ]; then
  log "Creating htpasswd for grafana vhost"
  command -v htpasswd >/dev/null || { apt-get update && apt-get install -y apache2-utils; }
  htpasswd -bc "$HTPASSWD_DIR/grafana" "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
  chmod 640 "$HTPASSWD_DIR/grafana"
  chown root:www-data "$HTPASSWD_DIR/grafana"
fi

# Render template → /etc/nginx/sites-available/<domain>. Only substitute the
# variable we name, so nginx's own $host / $remote_addr / etc. survive.
render_vhost() {
  local template="$1" domain="$2" varname="$3"
  log "Rendering nginx vhost: $domain"
  envsubst "\${$varname}" < "$APP_DIR/nginx/$template" > "$NGINX_SITES_AVAIL/$domain"
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
ensure_cert "$UMAMI_DOMAIN"
ensure_cert "$TELEMETRY_DOMAIN"

render_vhost grafana.conf.template   "$GRAFANA_DOMAIN"   GRAFANA_DOMAIN
render_vhost umami.conf.template     "$UMAMI_DOMAIN"     UMAMI_DOMAIN
render_vhost telemetry.conf.template "$TELEMETRY_DOMAIN" TELEMETRY_DOMAIN

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

log "Done."
log "Grafana:  https://$GRAFANA_DOMAIN   (basic auth: $BASIC_AUTH_USER / see .env)"
log "Umami:    https://$UMAMI_DOMAIN     (first-run admin / umami)"
