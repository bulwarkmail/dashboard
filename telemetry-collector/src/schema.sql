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

-- Heartbeats stored before the collector rounded `ts` to the day still
-- carry the send time. Drop it so stored payloads only hold the day.
UPDATE heartbeats
SET payload = jsonb_set(payload, '{ts}', to_jsonb(to_char(day, 'YYYY-MM-DD') || 'T00:00:00.000Z'))
WHERE payload->>'ts' IS DISTINCT FROM to_char(day, 'YYYY-MM-DD') || 'T00:00:00.000Z';

CREATE TABLE IF NOT EXISTS instance_meta (
  instance_id  uuid PRIMARY KEY,
  first_seen   date NOT NULL,
  last_seen    date NOT NULL,
  days_seen    integer NOT NULL DEFAULT 1
);

-- How many instance_meta rows the rollup deleted per day (instances not
-- seen within the retention window). Only a count, no instance_id, so
-- "instances ever seen" = count(instance_meta) + sum(count).
CREATE TABLE IF NOT EXISTS expired_instances (
  day    date PRIMARY KEY,
  count  integer NOT NULL
);

-- Heartbeats per UTC day (the day they arrived) from instance ids the
-- collector had not seen before. Those of the first
-- TELEMETRY_MAX_NEW_INSTANCES_PER_DAY are stored, the count goes on past
-- that. Only a count, no instance_id.
CREATE TABLE IF NOT EXISTS new_instance_counts (
  day    date PRIMARY KEY,
  count  integer NOT NULL
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

-- Error counts of schema 2 heartbeats (sent only with the instance's
-- separate error-count consent). One row per instance, day the errors
-- happened on (the day before the heartbeat), fingerprint and version.
-- Deleted after the retention window like heartbeats. instance_id never
-- leaves this table: the forwarder groups it away.
CREATE TABLE IF NOT EXISTS error_counts (
  instance_id   uuid    NOT NULL,
  day           date    NOT NULL,
  fingerprint   text    NOT NULL,
  version       text    NOT NULL,
  name          text    NOT NULL,
  frames        jsonb   NOT NULL,
  count_bucket  text    NOT NULL,
  days          integer NOT NULL,
  message       text,
  PRIMARY KEY (instance_id, day, fingerprint, version)
);
CREATE INDEX IF NOT EXISTS error_counts_day ON error_counts(day);
CREATE INDEX IF NOT EXISTS error_counts_group ON error_counts(day, fingerprint, version);

-- Which (day, fingerprint, version) groups went to Bugsink, so each goes once.
CREATE TABLE IF NOT EXISTS error_forwards (
  day           date        NOT NULL,
  fingerprint   text        NOT NULL,
  version       text        NOT NULL,
  forwarded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, fingerprint, version)
);

-- Which (day, fingerprint, version) groups went to Bugsink at once, from an
-- instant error-count batch (POST /v1/errors), so the first report of the
-- day goes once across instances. The daily forward above is separate.
CREATE TABLE IF NOT EXISTS error_instant_forwards (
  day           date        NOT NULL,
  fingerprint   text        NOT NULL,
  version       text        NOT NULL,
  forwarded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, fingerprint, version)
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id           bigserial PRIMARY KEY,
  job          text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  rows_processed integer,
  error          text
);
