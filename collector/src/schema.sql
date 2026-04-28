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
