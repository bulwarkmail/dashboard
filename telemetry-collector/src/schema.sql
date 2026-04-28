-- Idempotent. Runs at collector startup.
--
-- Privacy-relevant note: nothing in this schema stores IPs, headers,
-- hostnames, or anything tied to an end user. instance_id is a
-- pseudonym chosen by the install itself; we never link it to anything.

CREATE TABLE IF NOT EXISTS heartbeats (
  instance_id  uuid        NOT NULL,
  day          date        NOT NULL,
  payload      jsonb       NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, day)
);
CREATE INDEX IF NOT EXISTS heartbeats_day ON heartbeats(day);
CREATE INDEX IF NOT EXISTS heartbeats_received_at ON heartbeats(received_at);

CREATE TABLE IF NOT EXISTS instance_meta (
  instance_id  uuid PRIMARY KEY,
  first_seen   date NOT NULL,
  last_seen    date NOT NULL,
  days_seen    integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS daily_rollups (
  day                  date PRIMARY KEY,
  active_instances     integer NOT NULL,
  by_platform          jsonb   NOT NULL,
  by_version           jsonb   NOT NULL,
  by_os_family         jsonb   NOT NULL,
  feature_adoption     jsonb   NOT NULL,
  account_buckets      jsonb   NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id           bigserial PRIMARY KEY,
  job          text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  rows_processed integer,
  error          text
);
