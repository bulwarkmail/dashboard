-- Idempotent. Runs at collector startup.

CREATE TABLE IF NOT EXISTS repos (
  id              text PRIMARY KEY,            -- "owner/name"
  owner           text NOT NULL,
  name            text NOT NULL,
  default_branch  text,
  archived        boolean NOT NULL DEFAULT false,
  private         boolean NOT NULL DEFAULT false,
  primary_language text,
  description     text,
  homepage        text,
  created_at      timestamptz,
  pushed_at       timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_snapshots (
  repo_id      text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL DEFAULT now(),
  stars        integer NOT NULL,
  watchers     integer NOT NULL,
  forks        integer NOT NULL,
  open_issues  integer NOT NULL,
  open_prs     integer NOT NULL,
  subscribers  integer NOT NULL,
  size_kb      integer NOT NULL,
  PRIMARY KEY (repo_id, ts)
);
CREATE INDEX IF NOT EXISTS repo_snapshots_ts ON repo_snapshots (ts DESC);

CREATE TABLE IF NOT EXISTS traffic_views_daily (
  repo_id  text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day      date NOT NULL,
  count    integer NOT NULL,
  uniques  integer NOT NULL,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS traffic_clones_daily (
  repo_id  text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day      date NOT NULL,
  count    integer NOT NULL,
  uniques  integer NOT NULL,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS traffic_paths (
  repo_id  text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  path     text NOT NULL,
  title    text,
  count    integer NOT NULL,
  uniques  integer NOT NULL,
  PRIMARY KEY (repo_id, ts, path)
);

CREATE TABLE IF NOT EXISTS traffic_referrers (
  repo_id   text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  referrer  text NOT NULL,
  count     integer NOT NULL,
  uniques   integer NOT NULL,
  PRIMARY KEY (repo_id, ts, referrer)
);

CREATE TABLE IF NOT EXISTS releases (
  repo_id        text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  release_id     bigint NOT NULL,
  tag            text NOT NULL,
  name           text,
  draft          boolean NOT NULL DEFAULT false,
  prerelease     boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, release_id)
);

CREATE TABLE IF NOT EXISTS commit_snapshots (
  repo_id              text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ts                   timestamptz NOT NULL DEFAULT now(),
  total_commits        integer NOT NULL,
  commits_last_30d     integer NOT NULL,
  authors_last_30d     integer NOT NULL,
  head_sha             text,
  PRIMARY KEY (repo_id, ts)
);

CREATE TABLE IF NOT EXISTS loc_snapshots (
  repo_id   text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  language  text NOT NULL,
  files     integer NOT NULL,
  lines     integer NOT NULL,
  code      integer NOT NULL,
  comments  integer NOT NULL,
  blanks    integer NOT NULL,
  PRIMARY KEY (repo_id, ts, language)
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  repos_total  integer,
  repos_ok     integer,
  repos_err    integer,
  error        text
);
-- Grafana's read-only login (postgres/grafana-read-only.sql) may read every
-- table here but this one: its error text can hold credentials. The default
-- privileges grant it at CREATE TABLE, so take it back right here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_dashboard_ro') THEN
    REVOKE ALL ON TABLE collector_runs FROM grafana_dashboard_ro;
  END IF;
END $$;

-- Downloads dashboard (added 2026-10-19) -------------------------------------

-- Current state of every GitHub release asset, classified by `kind`.
CREATE TABLE IF NOT EXISTS release_assets (
  repo_id        text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  asset_id       bigint NOT NULL,
  release_id     bigint NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL,          -- android-apk | standalone-amd64 | standalone-arm64 | lite | lite-stalwart | checksum | mapping | other
  size_bytes     bigint,
  created_at     timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, asset_id)
);
CREATE INDEX IF NOT EXISTS release_assets_release ON release_assets (repo_id, release_id);

-- One row per asset whenever its download_count changes (first run = baseline).
CREATE TABLE IF NOT EXISTS release_asset_snapshots (
  repo_id        text NOT NULL,
  asset_id       bigint NOT NULL,
  ts             timestamptz NOT NULL DEFAULT now(),
  download_count integer NOT NULL,
  PRIMARY KEY (repo_id, asset_id, ts)
);
CREATE INDEX IF NOT EXISTS release_asset_snapshots_ts ON release_asset_snapshots (ts DESC);

-- ghcr.io package totals, scraped from the public package page.
CREATE TABLE IF NOT EXISTS container_packages (
  package        text PRIMARY KEY,       -- "bulwarkmail/webmail"
  repo_id        text,
  download_count bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS container_pull_snapshots (
  package        text NOT NULL,
  ts             timestamptz NOT NULL DEFAULT now(),
  download_count bigint NOT NULL,
  PRIMARY KEY (package, ts)
);
CREATE INDEX IF NOT EXISTS container_pull_snapshots_ts ON container_pull_snapshots (ts DESC);

-- TestFlight builds (App Store Connect betaBuildUsages metrics).
CREATE TABLE IF NOT EXISTS testflight_builds (
  build_id       text PRIMARY KEY,
  bundle_id      text NOT NULL,
  build_number   text NOT NULL,
  version        text,
  uploaded_at    timestamptz,
  expired        boolean NOT NULL DEFAULT false,
  install_count  integer NOT NULL DEFAULT 0,
  session_count  integer NOT NULL DEFAULT 0,
  crash_count    integer NOT NULL DEFAULT 0,
  feedback_count integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS testflight_build_snapshots (
  build_id       text NOT NULL,
  ts             timestamptz NOT NULL DEFAULT now(),
  install_count  integer NOT NULL,
  session_count  integer NOT NULL,
  PRIMARY KEY (build_id, ts)
);
CREATE INDEX IF NOT EXISTS testflight_build_snapshots_ts ON testflight_build_snapshots (ts DESC);
