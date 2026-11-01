# Bulwark Dashboard

Internal observability stack for the Bulwark org: Grafana + Prometheus + Postgres + Umami, plus a GitHub data collector.

## Components

- **Grafana** - dashboards, behind nginx basic auth, host port `3006`.
- **Prometheus** - scrapes `/metrics` from `relay`, `stalwart`, and the host. Internal docker network only.
- **Postgres 16** - backing store for Grafana, Umami, and the GitHub collector. Bound to `127.0.0.1:5432`.
- **Umami** - privacy-friendly web analytics. Public vhost; tracking script reachable from end-user browsers.
- **collector** (pm2) - periodically pulls per-repo GitHub stats (stars, issues, traffic, releases) and computes commits + LOC by cloning into `data/repos/`. Writes to the `dashboard` Postgres DB.
- **telemetry-collector** (pm2) - receives anonymous heartbeats from self-hosted instances, rolls them up, writes to the `telemetry` Postgres DB. Schema 2 heartbeats add error counts (`error_counts`, 90 days); with `BUGSINK_TELEMETRY_DSN` set, complete days are forwarded to Bugsink, one event per fingerprint, version and day, without instance ids.

## Layout on the server

```
$APP_DIR/
├── docker-compose.yml          # grafana, prometheus, postgres, umami
├── .env                        # secrets + site config, chmod 600
├── nginx/*.conf.template       # rendered with envsubst by deploy.sh
├── prometheus/prometheus.yml
├── grafana/provisioning/...
├── grafana/dashboards/*.json
├── postgres/init.sql           # creates grafana, umami, dashboard, telemetry DBs
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

First run: generates `.env` with random secrets and exits - fill in `GRAFANA_DOMAIN`, `UMAMI_DOMAIN`, `TELEMETRY_DOMAIN`, `LE_EMAIL`, then re-run.

Subsequent runs: render nginx vhost templates, request any missing Let's Encrypt certs, pull compose images, restart services, rebuild + reload the pm2 collectors.

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
