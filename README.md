# Bulwark Dashboard

Internal observability stack for the Bulwark org: Grafana + Prometheus + Postgres + Umami, plus a GitHub data collector.

## Components

- **Grafana** - dashboards, host port `3006`. The admin vhost has no nginx basic auth; Grafana's own login is the gate: the local admin account, or authentik with the `grafana-admin` role (Admin) or `grafana-viewer` role (Viewer). Anyone authentik lets through without one of those roles is refused. Its Postgres data sources log in with read-only roles, see below.
- **Prometheus** - scrapes `/metrics` from `relay`, `stalwart`, and the host. Internal docker network only. The relay wants its metrics token: put it in `secrets/relay-metrics-token` (one line, no newline needed); `deploy.sh` makes the file readable by Prometheus only.
- **Postgres 16** - backing store for Grafana, Umami, and the GitHub collector. Bound to `127.0.0.1:5432`.
- **Umami** - privacy-friendly web analytics. Public vhost; tracking script reachable from end-user browsers.
- **collector** (pm2) - periodically pulls per-repo GitHub stats (stars, issues, traffic, releases) and computes commits + LOC by cloning into `data/repos/`. Writes to the `dashboard` Postgres DB.
- **telemetry-collector** (pm2) - receives anonymous heartbeats from self-hosted instances, rolls them up, writes to the `telemetry` Postgres DB. Schema 2 heartbeats add error counts (`error_counts`, 90 days); with `BUGSINK_TELEMETRY_DSN` set, complete days are forwarded to Bugsink, one event per fingerprint, version and day, without instance ids. Instances in instant mode also post the current day's changed counts to `POST /v1/errors` (once per 30 s per instance); the first report of each error per day goes to Bugsink at once (`error_instant_forwards`, at most 30 a minute). At most 100 error groups a day go to Bugsink in all (`TELEMETRY_MAX_FORWARDED_GROUPS_PER_DAY`); the rest wait for the next day. A heartbeat counts for the UTC day it arrives, or the day before when it says it was sent then. Versions are `N.N.N` with at most 4 digits per number and 64 characters in all. Of the instance ids the collector hasn't seen before, at most 500 a day are stored (`TELEMETRY_MAX_NEW_INSTANCES_PER_DAY`, counted in `new_instance_counts`); past that a new id gets 200 and is dropped, with one warning a day in the log. nginx lets each address post 6 times a minute (burst 10) and keeps the addresses in memory only.

## Layout on the server

```
$APP_DIR/
├── docker-compose.yml          # grafana, prometheus, postgres, umami
├── .env                        # secrets + site config, chmod 600
├── secrets/                    # relay-metrics-token, the App Store Connect key (not in git)
├── nginx/*.conf.template       # rendered with envsubst by deploy.sh
├── prometheus/prometheus.yml
├── grafana/provisioning/...
├── grafana/dashboards/*.json
├── postgres/init.sql           # creates grafana, umami, dashboard, telemetry DBs
├── postgres/grafana-read-only.sql  # Grafana's read-only logins, run on every deploy
├── postgres/test/              # checks against a throwaway Postgres
├── collector/                  # pm2 service
├── telemetry-collector/        # pm2 service
└── data/
    ├── postgres/
    ├── prometheus/
    ├── grafana/
    └── repos/                  # bare clones for LOC/commit scans
```

## Deploy

```sh
./deploy.sh
```

First run: generates `.env` with random secrets and exits - fill in `GRAFANA_DOMAIN`, `UMAMI_DOMAIN`, `TELEMETRY_DOMAIN`, `LE_EMAIL` and `GRAFANA_OIDC_SECRET`, then re-run.

Subsequent runs render every nginx vhost from `nginx/*.conf.template` and overwrite what is in `/etc/nginx/sites-available`, so a change made on the host by hand belongs in the template first. Then they request any missing Let's Encrypt certs, pull compose images, restart services, rebuild + reload the pm2 collectors, apply Grafana's read-only database logins.

## Grafana's database logins

Grafana runs any SQL a signed-in user sends to a data source, Viewers included. So its three
Postgres data sources don't log in as the owners of the databases but as roles that can only read:

- `grafana_dashboard_ro` - every table of the GitHub collector in `dashboard`, also tables it adds
  later, except `collector_runs`.
- `grafana_umami_ro` - only `website`, `website_event`, `session` and `event_data` in `umami`.
  Umami's other tables (logins, API keys, two-factor secrets) stay closed.
- `grafana_telemetry_ro` - every table of the telemetry collector in `telemetry`.

They own nothing, can't create tables, temporary tables, functions or large objects, connect only to
their own database, take at most 10 connections and stop a statement after 15 seconds.
`postgres/grafana-read-only.sql` sets all of this. It is idempotent: a new data directory runs it
after `init.sql`, and `deploy.sh` runs it on every deploy, which also applies a changed password from
`.env` (`POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD`, `POSTGRES_GRAFANA_UMAMI_RO_PASSWORD`,
`POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD`; `deploy.sh` generates missing ones). By hand:

```sh
docker compose exec -T postgres psql -X -q -U postgres -d postgres < postgres/grafana-read-only.sql
```

`postgres/test/effective-privileges.sh` checks what the roles can do. It needs Docker and node,
starts a throwaway `postgres:16-alpine` with `init.sql`, lets the owners create their tables, runs
the grants file twice, asks Postgres what each role may do, and runs every dashboard panel's SQL
as its data source's role. It removes its container at the end and prints "all ok" or "FAILED":

```sh
bash postgres/test/effective-privileges.sh .
```

## Downloads dashboard (`grafana/dashboards/downloads.json`, uid `bulwark-downloads`)

Added 2026-10-19. The collector feeds three download sources into the `dashboard` DB:

- **GitHub release assets** - `release_assets` (current count per asset, classified in
  `kind`: `android-apk`, `standalone-amd64`, `standalone-arm64`, `lite`, `lite-stalwart`,
  `checksum`, `mapping`, `other`) and `release_asset_snapshots` (a row whenever the count
  changes). Classification lives in `collector/src/github.ts` (`classifyAsset`).
- **ghcr.io pulls** - `container_packages` / `container_pull_snapshots`. There is no API for
  pull counts; `collector/src/ghcr.ts` scrapes the "Total downloads" number from the public
  package page. Package list: `GHCR_PACKAGES` in `.env` (`repo/package,...`), default
  webmail, webmail-lite, webmail-beta, webmail-lite-beta, legacy-proxy.
- **TestFlight installs** - `testflight_builds` / `testflight_build_snapshots` from the App
  Store Connect `betaBuildUsages` metrics (`collector/src/testflight.ts`). Enabled only when
  `ASC_KEY_FILE` (the `.p8` key, in `secrets/`, mode 600), `ASC_KEY_ID` and `ASC_ISSUER_ID`
  are set in `.env` and the key file exists; otherwise it is skipped silently. Restart the
  collector after placing the key.

All three run on the fast (15 min) cycle. Per-day and "time range" panels are computed from
the change-only snapshots with `lag()`, so history starts at the first run (2026-10-19);
the all-time tiles use the live totals.
