-- Run every 5 seconds by the query-watchdog service (docker-compose.yml) as
-- grafana_query_watchdog, which may cancel non-superuser statements and see
-- every session's state (postgres/grafana-read-only.sql).
--
-- Grafana's read-only logins get statement_timeout = 15s and
-- idle_in_transaction_session_timeout = 60s as defaults, and a session can SET
-- both off. Here they hold whatever the session set: a statement of those
-- logins running longer than 20 seconds is cancelled, a session of theirs idle
-- in a transaction for more than 60 seconds is ended. Prints the two counts.
WITH slow AS MATERIALIZED (
  SELECT pid FROM pg_stat_activity
   WHERE usename IN ('grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro')
     AND state = 'active'
     AND now() - query_start > interval '20 seconds'
), stuck AS MATERIALIZED (
  SELECT pid FROM pg_stat_activity
   WHERE usename IN ('grafana_dashboard_ro', 'grafana_umami_ro', 'grafana_telemetry_ro')
     AND state LIKE 'idle in transaction%'
     AND now() - state_change > interval '60 seconds'
)
SELECT (SELECT count(*) FROM slow WHERE pg_cancel_backend(pid)) AS cancelled,
       (SELECT count(*) FROM stuck WHERE pg_terminate_backend(pid)) AS ended;
