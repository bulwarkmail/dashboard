# Bulwark Dashboard

Internal observability stack for the Bulwark org: Grafana + Prometheus + Postgres + Umami, plus a GitHub data collector.

## Components

- **Grafana** - dashboards, host port `3006`. The admin vhost has no nginx basic auth; Grafana's own login is the gate: the local admin account, or authentik with the `grafana-admin` role (Admin) or `grafana-viewer` role (Viewer). Anyone authentik lets through without one of those roles is refused. Its Postgres data sources log in with read-only roles, see below.
- **Prometheus** - scrapes `/metrics` from `relay`, `stalwart`, and the host. Internal docker network only. The relay wants its metrics token: put it in `secrets/relay-metrics-token` (one line, no newline needed); `deploy.sh` makes the file readable by Prometheus only.
- **Postgres 16** - backing store for Grafana, Umami, and the GitHub collector. Bound to `127.0.0.1:5432`.
- **Umami** - privacy-friendly web analytics. Public vhost; tracking script reachable from end-user browsers. On each deploy, `deploy.sh` replaces Umami's default admin login with `UMAMI_ADMIN_PASSWORD` from `.env` through Umami's API (a password changed by hand stays); until that worked, the vhost serves only `/script.js` and `/api/send`. Umami takes the visitor's address from `X-Real-IP`, which nginx sets.
- **collector** (pm2) - periodically pulls per-repo GitHub stats (stars, issues, traffic, releases) and computes commits + LOC by cloning into `data/repos/`. Writes to the `dashboard` Postgres DB. Runs as the system account `bulwark-collector`, which `deploy.sh` creates; it owns `data/repos` and reads `collector/.env` (its own variables, which `deploy.sh` copies there from `.env`) and the App Store Connect key through its group. As long as `collector/src/env.ts` still reads the stack's `.env`, `deploy.sh` leaves that file readable for the group too and says so; once it reads `collector/.env`, `.env` is root's alone. pm2 starts every app with `PATH` and `HOME` only (the apps read their `.env` themselves), and its saved list (`~/.pm2/dump.pm2`) is mode 600 and holds no secret. The scan takes only rows of `repos` that name a repository of `GITHUB_ORG` (default `bulwarkmail`) with an id of `<owner>/<name>`; any other row fails in that run. A renamed or moved repository fails too: its old row stays in `repos`, and GitHub answers the old name with a redirect, which the scan doesn't follow. Set `archived = true` on the old row (the one whose `last_seen_at` stopped moving). One repository's scan stops after `COLLECTOR_SCAN_DEADLINE_MS` (30 minutes), and its line count unpacks at most `COLLECTOR_UNPACK_MAX_BYTES` (1 GiB) and `COLLECTOR_UNPACK_MAX_ENTRIES` (200000 files, folders and links); a repository past a limit fails in that run. Failed repositories are in the log (`git.repo_failed`), the first one in `collector_runs.error`.
- **telemetry-collector** (pm2) - receives anonymous heartbeats from self-hosted instances, rolls them up, writes to the `telemetry` Postgres DB. Schema 2 heartbeats add error counts (`error_counts`, 90 days); with `BUGSINK_TELEMETRY_DSN` set, complete days are forwarded to Bugsink, one event per fingerprint, version and day, without instance ids. Instances in instant mode also post the current day's changed counts to `POST /v1/errors` (once per 30 s per instance); the first report of each error per day goes to Bugsink at once (`error_instant_forwards`, at most 30 a minute), but only from an instance the collector first stored more than a day before, by its own clock (`instance_arrivals`). At most 100 error groups a day go to Bugsink in all (`TELEMETRY_MAX_FORWARDED_GROUPS_PER_DAY`): instant forwards take at most half of them, and the daily forward of complete days, which sends widely reported groups first, has the rest. One instance brings in at most 10 of the day's groups (`TELEMETRY_MAX_FORWARDS_PER_INSTANCE_PER_DAY`); what doesn't fit waits for the next day. An error batch from an id the collector doesn't know takes one of the day's places for new ids (below), as a heartbeat does, and the id counts as known from then on: a desktop app with crash reports on and telemetry off never sends a heartbeat. With no place left the batch gets 429, and the webmail and desktop apps send it again later. Both routes read only bodies sent as `application/json` (415 otherwise). A heartbeat counts for the UTC day it arrives, or the day before when it says it was sent then. Versions are Bulwark's release shape only: `N.N.N` with at most 4 digits per number, optionally `-beta.N`, optionally `+desktop` (or `+desktop.<commit>`), 64 characters in all. Of the instance ids the collector hasn't seen before, at most 500 a day are stored at once (`TELEMETRY_MAX_NEW_INSTANCES_PER_DAY`, counted in `new_instance_counts`, heartbeats and error batches together); the next 5000 new ids that day wait in `pending_heartbeats` (`TELEMETRY_MAX_DEFERRED_PER_DAY`; one row per id and day, counted once, without its error counts, kept 7 days), anything past that is dropped, each with one warning a day in the log: on a day with more new ids than that, the further new installations of that day are not counted. Every hour up to 500 waiting ids a day are stored under their own days: ids that sent again on another day first, then ids waiting two days or more, oldest first. The public version table ranks versions by installations known for more than a day, counted from the day the collector first stored them by its own clock (`instance_arrivals`), not from a day a heartbeat names; then by all installations, and it leaves out a version only one new installation reports. nginx lets each address post 6 times a minute (burst 10) and keeps the addresses in memory only.
- **version-server** (pm2) - answers the apps' update check from the GitHub releases of `VERSION_SERVER_REPO` and from `version-server/overrides.json` (`minimumSupported`, and versions flagged `security` or `deprecated`). It doesn't start when that file is missing, isn't JSON, holds a key it doesn't know (a misspelt one, say) or a malformed entry. A file that turns bad later is logged at the next hourly refresh, and the overrides read before stay in use; `/health` then shows `"overridesStale": true` and `overridesProblem` (`missing`, `unreadable` or `invalid`) until the file is good again.

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
├── postgres/watchdog/          # the query-watchdog service's script
├── postgres/test/              # checks against a throwaway Postgres
├── collector/                  # pm2 service
├── telemetry-collector/        # pm2 service
├── version-server/             # pm2 service, overrides.json
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
their own database, take at most 10 connections and write at most 100 MB of temporary files per
query (`temp_file_limit`, which only a superuser can change). Nothing in the three databases is
granted to PUBLIC. `postgres/grafana-read-only.sql` sets all of this. It is idempotent: a new data
directory runs it after `init.sql`, and `deploy.sh` runs it on every deploy, right after Postgres is
up and again after the apps started. Each run also puts back the logins' passwords from `.env`
(`POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD`, `POSTGRES_GRAFANA_UMAMI_RO_PASSWORD`,
`POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD`; `deploy.sh` generates missing ones) and their settings:
Postgres lets every role change its own password and session defaults, so a Viewer can break its
own data source until the next deploy, but not keep it broken. The file stops, naming them, when a
database holds a schema other than `public` or a function that runs as its owner: the apps make
neither, so look at them and drop them. By hand:

```sh
docker compose exec -T postgres psql -X -q -U postgres -d postgres < postgres/grafana-read-only.sql
```

A statement of these logins gets 15 seconds by default (`statement_timeout`), but a session can
switch that off. The `query-watchdog` service (`postgres/watchdog/`) runs every 5 seconds as
`grafana_query_watchdog` (password `POSTGRES_QUERY_WATCHDOG_PASSWORD`), a login that may only see
sessions and cancel non-superuser statements: it cancels their statements after 20 seconds and ends
their sessions idle in a transaction for more than 60, whatever the session set. A session can still
raise its own `work_mem` for those 20 seconds.

`postgres/test/effective-privileges.sh` checks what the roles can do. It needs Docker and node,
starts a throwaway `postgres:16-alpine` with `init.sql`, lets the owners create their tables (and
leave a grant to PUBLIC behind), runs the grants file twice, asks Postgres what each role may do,
changes a login's settings and password as the login and checks the grants file puts them back,
lets the watchdog cancel a long statement, and runs every dashboard panel's SQL as its data
source's role. It removes its container at the end and prints "all ok" or "FAILED":

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
  `ASC_KEY_FILE` (the `.p8` key, in `secrets/`; `deploy.sh` makes it readable by the collector's group only), `ASC_KEY_ID` and `ASC_ISSUER_ID`
  are set in `.env` and the key file exists; otherwise it is skipped silently. Restart the
  collector after placing the key.

All three run on the fast (15 min) cycle. Per-day and "time range" panels are computed from
the change-only snapshots with `lag()`, so history starts at the first run (2026-10-19);
the all-time tiles use the live totals.
