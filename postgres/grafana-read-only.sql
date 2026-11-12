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
-- where it creates it. Nothing in the three databases is granted to PUBLIC.
--
-- Postgres lets every role change its own password and its own session
-- defaults (ALTER ROLE ... SET), and a session can SET its statement_timeout
-- off. So each run resets the logins' passwords and settings from the
-- environment, temp_file_limit (which only a superuser can change) bounds
-- what one query writes to disk, and the query-watchdog service
-- (postgres/watchdog/) cancels their statements after 20 seconds whatever
-- the session set, and ends the session of one still running at 30.
--
-- Idempotent: run it as the superuser any number of times, before or after
-- the apps created their tables, also while Grafana uses the logins: each
-- part runs in one transaction. A new data directory runs it after init.sql
-- (mounted as 20-grafana-read-only.sql), and deploy.sh runs it on every
-- deploy. It stops, naming them, when a database holds a schema other than
-- public or a function that runs as its owner: the apps make neither. By
-- hand, from the stack's folder:
--
--   docker compose exec -T postgres psql -X -q -U postgres -d postgres < postgres/grafana-read-only.sql
--
-- The passwords come from the postgres container's environment
-- (POSTGRES_GRAFANA_*_RO_PASSWORD and POSTGRES_QUERY_WATCHDOG_PASSWORD in
-- .env), so a password changed in .env is set by the next run.

\set ON_ERROR_STOP on

\set dashboard_ro_password `echo "$POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD"`
\set umami_ro_password     `echo "$POSTGRES_GRAFANA_UMAMI_RO_PASSWORD"`
\set telemetry_ro_password `echo "$POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD"`
\set watchdog_password     `echo "$POSTGRES_QUERY_WATCHDOG_PASSWORD"`

SELECT :'dashboard_ro_password' = '' OR :'umami_ro_password' = '' OR :'telemetry_ro_password' = '' OR :'watchdog_password' = '' AS missing_password \gset
\if :missing_password
  \echo 'Set POSTGRES_GRAFANA_DASHBOARD_RO_PASSWORD, POSTGRES_GRAFANA_UMAMI_RO_PASSWORD, POSTGRES_GRAFANA_TELEMETRY_RO_PASSWORD and POSTGRES_QUERY_WATCHDOG_PASSWORD in the postgres container.'
  DO $$ BEGIN RAISE EXCEPTION 'a Grafana read-only or watchdog password is empty'; END $$;
\endif

-- The roles and what they may do with the databases, in one transaction: a
-- session that starts while this runs (deploy.sh runs it on a live stack)
-- sees the logins as they were or as they are after it, never reset halfway,
-- without their limits or without CONNECT.
BEGIN;

-- The roles: init.sql creates them in a new data directory, this in an
-- existing one.
SELECT format('CREATE ROLE %I', r)
  FROM unnest(ARRAY['grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro', 'grafana_query_watchdog']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- Whatever the logins set for themselves goes: every per-role and
-- per-database setting, then the password and the settings below.
SELECT format('ALTER ROLE %I IN DATABASE %I RESET ALL', r.rolname, d.datname)
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  JOIN pg_database d ON d.oid = s.setdatabase
 WHERE r.rolname IN ('grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro', 'grafana_query_watchdog') \gexec
ALTER ROLE grafana_dashboard_ro   RESET ALL;
ALTER ROLE grafana_umami_ro       RESET ALL;
ALTER ROLE grafana_telemetry_ro   RESET ALL;
ALTER ROLE grafana_query_watchdog RESET ALL;

-- Login, no special attribute, at most 10 connections. A statement runs 15
-- seconds by default (the watchdog stops it at 20 when a session switched
-- that off), a query writes at most 100 MB of temporary files, and sessions
-- are read-only by default; a session can switch that off too, so the
-- privileges further down are the limit.
ALTER ROLE grafana_dashboard_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'dashboard_ro_password';
ALTER ROLE grafana_umami_ro     WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'umami_ro_password';
ALTER ROLE grafana_telemetry_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'telemetry_ro_password';
ALTER ROLE grafana_dashboard_ro SET statement_timeout = '15s';
ALTER ROLE grafana_umami_ro     SET statement_timeout = '15s';
ALTER ROLE grafana_telemetry_ro SET statement_timeout = '15s';
ALTER ROLE grafana_dashboard_ro SET temp_file_limit = '100MB';
ALTER ROLE grafana_umami_ro     SET temp_file_limit = '100MB';
ALTER ROLE grafana_telemetry_ro SET temp_file_limit = '100MB';
ALTER ROLE grafana_dashboard_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_umami_ro     SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_telemetry_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE grafana_dashboard_ro SET default_transaction_read_only = on;
ALTER ROLE grafana_umami_ro     SET default_transaction_read_only = on;
ALTER ROLE grafana_telemetry_ro SET default_transaction_read_only = on;

-- The watchdog (postgres/watchdog/): sees every session's state and may
-- cancel non-superuser statements and end their sessions, nothing else; it
-- connects to postgres only.
ALTER ROLE grafana_query_watchdog WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'watchdog_password';
ALTER ROLE grafana_query_watchdog SET statement_timeout = '5s';
ALTER ROLE grafana_query_watchdog SET default_transaction_read_only = on;

-- A member of another role has that role's rights: no memberships, but the
-- watchdog's two.
SELECT format('REVOKE %I FROM %I GRANTED BY %I', g.rolname, m.rolname, gr.rolname)
  FROM pg_auth_members a
  JOIN pg_roles g  ON g.oid = a.roleid
  JOIN pg_roles m  ON m.oid = a.member
  JOIN pg_roles gr ON gr.oid = a.grantor
 WHERE m.rolname IN ('grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro')
    OR (m.rolname = 'grafana_query_watchdog' AND g.rolname NOT IN ('pg_signal_backend', 'pg_read_all_stats')) \gexec
GRANT pg_signal_backend, pg_read_all_stats TO grafana_query_watchdog;

-- Each role connects to its own database only. PUBLIC may neither connect to
-- nor create temporary tables in any database here; an owner keeps both on
-- its own database through ownership.
REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1, grafana, umami, dashboard, telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE postgres, template1, grafana, umami, dashboard, telemetry FROM grafana_dashboard_ro, grafana_umami_ro, grafana_telemetry_ro, grafana_query_watchdog;
GRANT CONNECT ON DATABASE dashboard TO grafana_dashboard_ro;
GRANT CONNECT ON DATABASE umami     TO grafana_umami_ro;
GRANT CONNECT ON DATABASE telemetry TO grafana_telemetry_ro;
GRANT CONNECT ON DATABASE postgres  TO grafana_query_watchdog;

COMMIT;

-- In each of the three databases, first the same check and clean-up: stop
-- when a schema other than public or a function that runs as its owner is
-- there (the apps make neither; look at them and drop them), then take away
-- what PUBLIC was granted on the schema, its tables, sequences and functions
-- (extension functions, owned by the superuser, keep theirs), and in the
-- owner's default privileges, and the large-object functions.

-- dashboard: every table of the GitHub collector but collector_runs, also the
-- ones it creates later.
\connect dashboard
BEGIN;
DO $$
DECLARE
  owner text := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
  found text;
  f regprocedure;
BEGIN
  SELECT string_agg(what, '; ') INTO found FROM (
    SELECT 'schema ' || quote_ident(nspname) AS what FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure || ' (runs as its owner)'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) x;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'database %: % - the apps make none of this; look at it and drop it, then run this file again', current_database(), found;
  END IF;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
END $$;
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
COMMIT;

-- umami: the four tables the website and marketplace dashboards read, once
-- Umami has created them. Nothing it creates later.
\connect umami
BEGIN;
DO $$
DECLARE
  owner text := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
  found text;
  f regprocedure;
BEGIN
  SELECT string_agg(what, '; ') INTO found FROM (
    SELECT 'schema ' || quote_ident(nspname) AS what FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure || ' (runs as its owner)'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) x;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'database %: % - the apps make none of this; look at it and drop it, then run this file again', current_database(), found;
  END IF;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
END $$;
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
COMMIT;

-- telemetry: every table of the telemetry collector, also the ones it creates
-- later.
\connect telemetry
BEGIN;
DO $$
DECLARE
  owner text := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
  found text;
  f regprocedure;
BEGIN
  SELECT string_agg(what, '; ') INTO found FROM (
    SELECT 'schema ' || quote_ident(nspname) AS what FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure || ' (runs as its owner)'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) x;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'database %: % - the apps make none of this; look at it and drop it, then run this file again', current_database(), found;
  END IF;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner);
  REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM PUBLIC;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO telemetry;
REVOKE ALL ON SCHEMA public FROM grafana_telemetry_ro;
GRANT USAGE ON SCHEMA public TO grafana_telemetry_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_telemetry_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM grafana_telemetry_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_telemetry_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE telemetry IN SCHEMA public REVOKE ALL ON TABLES FROM grafana_telemetry_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE telemetry IN SCHEMA public GRANT SELECT ON TABLES TO grafana_telemetry_ro;
COMMIT;
