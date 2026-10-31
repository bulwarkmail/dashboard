import { pool } from './db.js';
import {
  listOrgRepos,
  countOpenPullRequests,
  fetchSubscribers,
  fetchTrafficViews,
  fetchTrafficClones,
  fetchTopPaths,
  fetchTopReferrers,
  fetchReleases,
  classifyAsset,
  type RepoLite,
} from './github.js';
import { env } from './env.js';
import { log } from './log.js';

async function upsertRepo(r: RepoLite): Promise<void> {
  await pool.query(
    `INSERT INTO repos (id, owner, name, default_branch, archived, private, primary_language, description, homepage, created_at, pushed_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (id) DO UPDATE SET
       owner            = EXCLUDED.owner,
       name             = EXCLUDED.name,
       default_branch   = EXCLUDED.default_branch,
       archived         = EXCLUDED.archived,
       private          = EXCLUDED.private,
       primary_language = EXCLUDED.primary_language,
       description      = EXCLUDED.description,
       homepage         = EXCLUDED.homepage,
       created_at       = EXCLUDED.created_at,
       pushed_at        = EXCLUDED.pushed_at,
       last_seen_at     = now()`,
    [
      r.id, r.owner, r.name, r.defaultBranch, r.archived, r.private,
      r.language, r.description, r.homepage, r.createdAt, r.pushedAt,
    ],
  );
}

async function snapshotOne(r: RepoLite): Promise<void> {
  const [openPrs, subscribers] = await Promise.all([
    countOpenPullRequests(r.owner, r.name),
    fetchSubscribers(r.owner, r.name),
  ]);
  const openIssuesOnly = Math.max(0, r.openIssues - openPrs);

  await pool.query(
    `INSERT INTO repo_snapshots (repo_id, ts, stars, watchers, forks, open_issues, open_prs, subscribers, size_kb)
     VALUES ($1, now(), $2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (repo_id, ts) DO NOTHING`,
    [r.id, r.stars, r.watchers, r.forks, openIssuesOnly, openPrs, subscribers, r.sizeKb],
  );

  // Traffic - replace last 14 days each run; the API only retains 14 days anyway.
  const [views, clones, paths, referrers] = await Promise.all([
    fetchTrafficViews(r.owner, r.name),
    fetchTrafficClones(r.owner, r.name),
    fetchTopPaths(r.owner, r.name),
    fetchTopReferrers(r.owner, r.name),
  ]);

  for (const v of views) {
    await pool.query(
      `INSERT INTO traffic_views_daily (repo_id, day, count, uniques) VALUES ($1,$2,$3,$4)
       ON CONFLICT (repo_id, day) DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques`,
      [r.id, v.day, v.count, v.uniques],
    );
  }
  for (const c of clones) {
    await pool.query(
      `INSERT INTO traffic_clones_daily (repo_id, day, count, uniques) VALUES ($1,$2,$3,$4)
       ON CONFLICT (repo_id, day) DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques`,
      [r.id, c.day, c.count, c.uniques],
    );
  }
  // top paths/referrers are point-in-time - store under current ts.
  for (const p of paths) {
    await pool.query(
      `INSERT INTO traffic_paths (repo_id, path, title, count, uniques) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (repo_id, ts, path) DO NOTHING`,
      [r.id, p.path, p.title, p.count, p.uniques],
    );
  }
  for (const ref of referrers) {
    await pool.query(
      `INSERT INTO traffic_referrers (repo_id, referrer, count, uniques) VALUES ($1,$2,$3,$4)
       ON CONFLICT (repo_id, ts, referrer) DO NOTHING`,
      [r.id, ref.referrer, ref.count, ref.uniques],
    );
  }

  // Releases + per-asset download counts (with a change-only history for the downloads dashboard).
  const releases = await fetchReleases(r.owner, r.name);
  for (const rel of releases) {
    await pool.query(
      `INSERT INTO releases (repo_id, release_id, tag, name, draft, prerelease, published_at, download_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (repo_id, release_id) DO UPDATE SET
         tag = EXCLUDED.tag,
         name = EXCLUDED.name,
         draft = EXCLUDED.draft,
         prerelease = EXCLUDED.prerelease,
         published_at = EXCLUDED.published_at,
         download_count = EXCLUDED.download_count`,
      [r.id, rel.releaseId, rel.tag, rel.name, rel.draft, rel.prerelease, rel.publishedAt, rel.downloads],
    );
    for (const a of rel.assets) {
      await pool.query(
        `INSERT INTO release_assets (repo_id, asset_id, release_id, name, kind, size_bytes, created_at, download_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (repo_id, asset_id) DO UPDATE SET
           release_id = EXCLUDED.release_id,
           name = EXCLUDED.name,
           kind = EXCLUDED.kind,
           size_bytes = EXCLUDED.size_bytes,
           created_at = EXCLUDED.created_at,
           download_count = EXCLUDED.download_count,
           updated_at = now()`,
        [r.id, a.assetId, rel.releaseId, a.name, classifyAsset(a.name), a.sizeBytes, a.createdAt, a.downloads],
      );
      await pool.query(
        `INSERT INTO release_asset_snapshots (repo_id, asset_id, ts, download_count)
         SELECT $1, $2, now(), $3
         WHERE COALESCE((SELECT download_count FROM release_asset_snapshots
                         WHERE repo_id = $1 AND asset_id = $2 ORDER BY ts DESC LIMIT 1), -1) <> $3`,
        [r.id, a.assetId, a.downloads],
      );
    }
  }
}

export async function runSnapshot(): Promise<void> {
  const runId = (await pool.query(
    `INSERT INTO collector_runs (job) VALUES ('snapshot') RETURNING id`,
  )).rows[0].id as number;

  let ok = 0;
  let err = 0;
  let total = 0;
  let firstError: string | null = null;
  try {
    const repos = await listOrgRepos(env.githubOrg);
    total = repos.length;
    for (const r of repos) {
      try {
        await upsertRepo(r);
        await snapshotOne(r);
        ok++;
      } catch (e) {
        err++;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstError) firstError = `${r.id}: ${msg}`;
        log.warn('snapshot.repo_failed', { repo: r.id, err: msg });
      }
    }
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e);
    log.error('snapshot.aborted', { err: firstError });
  } finally {
    await pool.query(
      `UPDATE collector_runs SET finished_at = now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id = $1`,
      [runId, total, ok, err, firstError],
    );
    log.info('snapshot.done', { total, ok, err });
  }
}
