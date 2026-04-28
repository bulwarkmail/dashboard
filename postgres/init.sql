-- Runs once on first postgres container start (empty data dir).
-- Creates per-app users + databases. Passwords come from env vars
-- baked into the postgres container at startup.

\set grafana_password   `echo "$POSTGRES_GRAFANA_PASSWORD"`
\set umami_password     `echo "$POSTGRES_UMAMI_PASSWORD"`
\set dashboard_password `echo "$POSTGRES_DASHBOARD_PASSWORD"`
\set telemetry_password `echo "$POSTGRES_TELEMETRY_PASSWORD"`

CREATE USER grafana   WITH PASSWORD :'grafana_password';
CREATE USER umami     WITH PASSWORD :'umami_password';
CREATE USER dashboard WITH PASSWORD :'dashboard_password';
CREATE USER telemetry WITH PASSWORD :'telemetry_password';

CREATE DATABASE grafana   OWNER grafana;
CREATE DATABASE umami     OWNER umami;
CREATE DATABASE dashboard OWNER dashboard;
CREATE DATABASE telemetry OWNER telemetry;
