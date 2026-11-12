-- Runs once on first postgres container start (empty data dir).
-- Creates per-app users + databases. Passwords come from env vars
-- baked into the postgres container at startup.

\set grafana_password   `echo "$POSTGRES_GRAFANA_PASSWORD"`
\set umami_password     `echo "$POSTGRES_UMAMI_PASSWORD"`
\set dashboard_password `echo "$POSTGRES_DASHBOARD_PASSWORD"`
\set telemetry_password `echo "$POSTGRES_TELEMETRY_PASSWORD"`
\set grafana_dashboard_ro_password `echo "$POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD"`
\set grafana_umami_ro_password     `echo "$POSTGRES_GRAFANA_UMAMI_RO_PASSWORD"`
\set grafana_telemetry_ro_password `echo "$POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD"`
\set grafana_warden_ro_password    `echo "$POSTGRES_GRAFANA_WARDEN_RO_PASSWORD"`
\set query_watchdog_password       `echo "$POSTGRES_QUERY_WATCHDOG_PASSWORD"`

CREATE USER grafana   WITH PASSWORD :'grafana_password';
CREATE USER umami     WITH PASSWORD :'umami_password';
CREATE USER dashboard WITH PASSWORD :'dashboard_password';
CREATE USER telemetry WITH PASSWORD :'telemetry_password';

CREATE DATABASE grafana   OWNER grafana;
CREATE DATABASE umami     OWNER umami;
CREATE DATABASE dashboard OWNER dashboard;
CREATE DATABASE telemetry OWNER telemetry;

-- Grafana's data sources log in with these, one per database, and may only
-- read. Their rights come from grafana-read-only.sql, which the container
-- runs right after this file (20-grafana-read-only.sql) and deploy.sh runs
-- on every deploy.
CREATE ROLE grafana_dashboard_ro LOGIN PASSWORD :'grafana_dashboard_ro_password';
CREATE ROLE grafana_umami_ro     LOGIN PASSWORD :'grafana_umami_ro_password';
CREATE ROLE grafana_telemetry_ro LOGIN PASSWORD :'grafana_telemetry_ro_password';
-- For the Warden bot's warden database, which the bot creates, not this file.
CREATE ROLE grafana_warden_ro    LOGIN PASSWORD :'grafana_warden_ro_password';
-- Cancels their statements that run too long (postgres/watchdog/).
CREATE ROLE grafana_query_watchdog LOGIN PASSWORD :'query_watchdog_password';
