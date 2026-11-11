-- Read-only logins for Grafana's data sources.
--
-- Grafana runs any SQL a signed-in user sends to a data source, so the login
-- of a data source decides what every Grafana user can do in its database.
-- The three roles here may read the tables the dashboards use and nothing
-- else: they own nothing, belong to no other role, can't create anything
-- (CREATE on the schema and TEMPORARY on the database are not granted to
-- PUBLIC), can't create large objects, and may connect to their own database
-- only. Not readable:
--   - umami: every table but the four the dashboards read (the others hold
--     the logins, API keys and two-factor secrets);
--   - dashboard: collector_runs, whose error text can hold credentials.
-- A table a collector creates later is readable through the default
-- privileges below; collector/src/schema.sql revokes collector_runs right
-- where it creates it.
--
-- Idempotent: run it as the superuser any number of times, before or after
-- the apps created their tables. A new data directory runs it after init.sql
-- (mounted as 20-grafana-read-only.sql), and deploy.sh runs it on every
-- deploy. By hand, from the stack's folder:
--
--   docker compose exec -T postgres psql -X -q -U postgres -d postgres < postgres/grafana-read-only.sql
--
-- The passwords come from the postgres container's environment
-- (POSTGRES_GRAFANA_*_RO_PASSWORD in .env), so a password changed in .env is
-- set by the next run.

\set ON_ERROR_STOP on

\set dashboard_ro_password `echo "$POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD"`
\set umami_ro_password     `echo "$POSTGRES_GRAFANA_UMAMI_RO_PASSWORD"`
\set telemetry_ro_password `echo "$POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD"`

SELECT :'dashboard_ro_password' = '' OR :'umami_ro_password' = '' OR :'telemetry_ro_password' = '' AS missing_password \gset
\if :missing_password
  \echo 'Set POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD, POSTGRES_GRAFANA_UMAMI_RO_PASSWORD and POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD in the postgres container.'
  DO $$ BEGIN RAISE EXCEPTION 'a Grafana read-only password is empty'; END $$;
\endif

-- The roles: init.sql creates them in a new data directory, this in an
-- existing one.
SELECT format('CREATE ROLE %I', r)
  FROM unnest(ARRAY['grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- Login, no special attribute, at most 10 connections, 15 seconds per
-- statement. Read-only by default as well; a session can switch that off,
-- so the privileges further down are the limit.
ALTER ROLE grafana_dashboard_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'dashboard_ro_password';
ALTER ROLE grafana_umami_ro     WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'umami_ro_password';
ALTER ROLE grafana_telemetry_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'telemetry_ro_password';
ALTER ROLE grafana_dashboard_ro SET statement_timeout = '15s';
ALTER ROLE grafana_umami_ro     SET statement_timeout = '15s';
ALTER ROLE grafana_telemetry_ro SET statement_timeout = '15s';
ALTER ROLE grafana_dashboard_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_umami_ro     SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_telemetry_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_dashboard_ro SET default_transaction_read_only = on;
ALTER ROLE grafana_umami_ro     SET default_transaction_read_only = on;
ALTER ROLE grafana_telemetry_ro SET default_transaction_read_only = on;

-- A member of another role has that role's rights: no memberships.
SELECT format('REVOKE %I FROM %I GRANTED BY %I', g.rolname, m.rolname, gr.rolname)
  FROM pg_auth_members a
  JOIN pg_roles g  ON g.oid = a.roleid
  JOIN pg_roles m  ON m.oid = a.member
  JOIN pg_roles gr ON gr.oid = a.grantor
 WHERE m.rolname IN ('grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro') \gexec

-- Each role connects to its own database only. PUBLIC may neither connect to
-- nor create temporary tables in any database here; an owner keeps both on
-- its own database through ownership.
REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1, grafana, umami, dashboard, telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE postgres, template1, grafana, umami, dashboard, telemetry FROM grafana_dashboard_ro, grafana_umami_ro, grafana_telemetry_ro;
GRANT CONNECT ON DATABASE dashboard TO grafana_dashboard_ro;
GRANT CONNECT ON DATABASE umami     TO grafana_umami_ro;
GRANT CONNECT ON DATABASE telemetry TO grafana_telemetry_ro;

-- dashboard: every table of the GitHub collector but collector_runs, also the
-- ones it creates later.
\connect dashboard
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO dashboard;
REVOKE ALL ON SCHEMA public FROM grafana_dashboard_ro;
GRANT USAGE ON SCHEMA public TO grafana_dashboard_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_dashboard_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM grafana_dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_dashboard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard IN SCHEMA public REVOKE ALL ON TABLES FROM grafana_dashboard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard IN SCHEMA public GRANT SELECT ON TABLES TO grafana_dashboard_ro;
DO $$ BEGIN
  IF to_regclass('public.collector_runs') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.collector_runs FROM grafana_dashboard_ro;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
COMMIT;

-- umami: the four tables the website and marketplace dashboards read, once
-- Umami has created them. Nothing it creates later.
\connect umami
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO umami;
REVOKE ALL ON SCHEMA public FROM grafana_umami_ro;
GRANT USAGE ON SCHEMA public TO grafana_umami_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_umami_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM grafana_umami_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE umami IN SCHEMA public REVOKE ALL ON TABLES FROM grafana_umami_ro;
SELECT format('GRANT SELECT ON TABLE %s TO grafana_umami_ro', c.oid::regclass)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p')
   AND c.relname IN ('website', 'website_event', 'session', 'event_data') \gexec
REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
COMMIT;

-- telemetry: every table of the telemetry collector, also the ones it creates
-- later.
\connect telemetry
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO telemetry;
REVOKE ALL ON SCHEMA public FROM grafana_telemetry_ro;
GRANT USAGE ON SCHEMA public TO grafana_telemetry_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_telemetry_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM grafana_telemetry_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_telemetry_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE telemetry IN SCHEMA public REVOKE ALL ON TABLES FROM grafana_telemetry_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE telemetry IN SCHEMA public GRANT SELECT ON TABLES TO grafana_telemetry_ro;
REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
COMMIT;
