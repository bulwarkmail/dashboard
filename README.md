# Bulwark Dashboard

Internal observability stack for the Bulwark org: Grafana + Prometheus + Postgres + Umami, plus a GitHub data collector.

## Components

- **Grafana** - dashboards, behind nginx basic auth, host port `3006`.
- **Prometheus** - scrapes `/metrics` from `relay`, `stalwart`, and the host. Internal docker network only.
- **Postgres 16** - backing store for Grafana, Umami, and the GitHub collector. Bound to `127.0.0.1:5432`.
- **Umami** - privacy-friendly web analytics. Public vhost; tracking script reachable from end-user browsers.
- **collector** (pm2) - periodically pulls per-repo GitHub stats (stars, issues, traffic, releases) and computes commits + LOC by cloning into `data/repos/`. Writes to the `dashboard` Postgres DB.
- **telemetry-collector** (pm2) - receives anonymous heartbeats from self-hosted instances, rolls them up, writes to the `telemetry` Postgres DB.

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
