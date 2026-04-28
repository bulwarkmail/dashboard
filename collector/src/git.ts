import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';

const exec = promisify(execFile);

interface RepoRow { id: string; owner: string; name: string; }

async function ensureClone(repoId: string, owner: string, name: string): Promise<string> {
  const dir = path.join(env.reposDir, repoId);
  await fs.mkdir(env.reposDir, { recursive: true });
  let exists = false;
  try { await fs.stat(path.join(dir, 'objects')); exists = true; } catch { /* not yet */ }
  const url = `https://x-access-token:${env.githubToken}@github.com/${owner}/${name}.git`;
  if (!exists) {
    await fs.mkdir(dir, { recursive: true });
    await exec('git', ['clone', '--bare', '--filter=blob:none', url, dir], { maxBuffer: 64 * 1024 * 1024 });
  } else {
    await exec('git', ['--git-dir', dir, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return dir;
}

async function gitOut(gitDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--git-dir', gitDir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function commitStats(gitDir: string, defaultBranch: string): Promise<{
  total: number; last30d: number; authors30d: number; head: string;
}> {
  const head = (await gitOut(gitDir, ['rev-parse', defaultBranch])).trim();
  const total = parseInt((await gitOut(gitDir, ['rev-list', '--count', defaultBranch])).trim(), 10) || 0;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last30d = parseInt(
    (await gitOut(gitDir, ['rev-list', '--count', `--since=${since}`, defaultBranch])).trim(),
    10,
  ) || 0;
  const authorLines = (await gitOut(gitDir, ['log', `--since=${since}`, '--format=%ae', defaultBranch]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const authors30d = new Set(authorLines).size;
  return { total, last30d, authors30d, head };
}

// Best-effort LOC counter using `scc` if installed; falls back to line count by extension.
async function locByLanguage(gitDir: string, defaultBranch: string): Promise<Array<{
  language: string; files: number; lines: number; code: number; comments: number; blanks: number;
}>> {
  // Materialize the working tree of HEAD into a tmp dir so scc/cloc can read it.
  const tmp = await fs.mkdtemp(path.join('/tmp', 'loc-'));
  try {
    await exec(
      'sh',
      ['-c', `git --git-dir='${gitDir}' archive --format=tar ${defaultBranch} | tar -x -C '${tmp}'`],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    // Strip lock files, license text, and other generated/legal files that
    // scc counts as code but aren't meaningfully part of the codebase.
    const stripNames = new Set([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
      'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'composer.lock',
      'go.sum', 'flake.lock',
      'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.txt',
    ]);
    let stripped = 0;
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && stripNames.has(e.name)) {
          await fs.rm(full, { force: true });
          stripped++;
        }
      }
    }
    await walk(tmp).catch(() => undefined);
    log.info('git.loc.strip', { repo: gitDir, stripped });
    try {
      const { stdout } = await exec('scc', ['--no-cocomo', '--no-complexity', '--format', 'json', tmp], {
        maxBuffer: 64 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as Array<{
        Name: string; Count: number; Lines: number; Code: number; Comment: number; Blank: number;
      }>;
      return parsed.map((p) => ({
        language: p.Name,
        files: p.Count,
        lines: p.Lines,
        code: p.Code,
        comments: p.Comment,
        blanks: p.Blank,
      }));
    } catch {
      // Fallback: total lines under all tracked files, language=ALL.
      const { stdout } = await exec('sh', ['-c', `find '${tmp}' -type f -print0 | xargs -0 wc -l 2>/dev/null | tail -1`]);
      const total = parseInt(stdout.trim().split(/\s+/)[0] ?? '0', 10) || 0;
      return [{ language: 'ALL', files: 0, lines: total, code: total, comments: 0, blanks: 0 }];
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function runGitScan(): Promise<void> {
  const runId = (await pool.query(
    `INSERT INTO collector_runs (job) VALUES ('git') RETURNING id`,
  )).rows[0].id as number;

  let ok = 0; let err = 0; let total = 0; let firstError: string | null = null;
  try {
    const { rows } = await pool.query<RepoRow>(
      `SELECT id, owner, name FROM repos WHERE archived = false AND default_branch IS NOT NULL`,
    );
    total = rows.length;
    for (const r of rows) {
      try {
        const dir = await ensureClone(r.id, r.owner, r.name);
        const branchRow = await pool.query<{ default_branch: string }>(
          `SELECT default_branch FROM repos WHERE id=$1`, [r.id],
        );
        const branch = branchRow.rows[0]?.default_branch ?? 'main';
        const stats = await commitStats(dir, branch);
        await pool.query(
          `INSERT INTO commit_snapshots (repo_id, total_commits, commits_last_30d, authors_last_30d, head_sha)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (repo_id, ts) DO NOTHING`,
          [r.id, stats.total, stats.last30d, stats.authors30d, stats.head],
        );
        const langs = await locByLanguage(dir, branch);
        for (const l of langs) {
          await pool.query(
            `INSERT INTO loc_snapshots (repo_id, language, files, lines, code, comments, blanks)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (repo_id, ts, language) DO NOTHING`,
            [r.id, l.language, l.files, l.lines, l.code, l.comments, l.blanks],
          );
        }
        ok++;
      } catch (e) {
        err++;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstError) firstError = `${r.id}: ${msg}`;
        log.warn('git.repo_failed', { repo: r.id, err: msg });
      }
    }
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e);
    log.error('git.aborted', { err: firstError });
  } finally {
    await pool.query(
      `UPDATE collector_runs SET finished_at=now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id=$1`,
      [runId, total, ok, err, firstError],
    );
    log.info('git.done', { total, ok, err });
  }
}
