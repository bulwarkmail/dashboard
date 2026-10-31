import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';

// ghcr.io has no pull-count API. The public package page shows
// "Total downloads" with the exact number in the h3 title attribute.
export async function fetchGhcrDownloads(repo: string, pkg: string): Promise<number | null> {
  const url = `https://github.com/${env.githubOrg}/${repo}/pkgs/container/${pkg}`;
  const res = await fetch(url, { headers: { 'user-agent': 'bulwark-dashboard-collector/0.1' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const html = await res.text();
  const idx = html.indexOf('Total downloads');
  if (idx < 0) return null;
  const m = html.slice(idx, idx + 400).match(/<h3[^>]*title="(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}

export async function runGhcr(): Promise<void> {
  let ok = 0; let err = 0;
  for (const { repo, pkg } of env.ghcrPackages) {
    const name = `${env.githubOrg}/${pkg}`;
    try {
      const count = await fetchGhcrDownloads(repo, pkg);
      if (count === null) { log.warn('ghcr.no_count', { pkg: name }); err++; continue; }
      await pool.query(
        `INSERT INTO container_packages (package, repo_id, download_count, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (package) DO UPDATE SET repo_id = EXCLUDED.repo_id, download_count = EXCLUDED.download_count, updated_at = now()`,
        [name, `${env.githubOrg}/${repo}`, count],
      );
      await pool.query(
        `INSERT INTO container_pull_snapshots (package, ts, download_count)
         SELECT $1, now(), $2
         WHERE COALESCE((SELECT download_count FROM container_pull_snapshots WHERE package = $1 ORDER BY ts DESC LIMIT 1), -1) <> $2`,
        [name, count],
      );
      ok++;
    } catch (e) {
      err++;
      log.warn('ghcr.failed', { pkg: name, err: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info('ghcr.done', { ok, err });
}
