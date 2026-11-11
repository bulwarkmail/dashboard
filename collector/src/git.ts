import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';

// Every program is started with an argument list, never through a shell: repository ids, owners,
// names and branch names come from GitHub and from the repos table.
const exec = promisify(execFile);

interface RepoRow { id: string; owner: string; name: string; }

// Owner and repository names as GitHub allows them.
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

function isGithubName(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_NAME.test(value) && value !== '.' && value !== '..';
}

/**
 * The clone directory of a row, `<reposDir>/<owner>/<name>`. Throws when the id, owner or name is
 * not a GitHub name, before anything becomes a path or part of a URL.
 */
function cloneDir(r: RepoRow): string {
  const parts = typeof r.id === 'string' ? r.id.split('/') : [];
  if (parts.length !== 2 || !parts.every(isGithubName)) throw new Error('repository id is not <owner>/<name>');
  if (!isGithubName(r.owner) || !isGithubName(r.name)) throw new Error('owner or name is not a GitHub name');
  const root = path.resolve(env.reposDir);
  const dir = path.resolve(root, parts[0], parts[1]);
  const rel = path.relative(root, dir);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('clone directory is outside the repos folder');
  }
  return dir;
}

/**
 * `refs/heads/<branch>` once git's ref-name rules accept it. A leading dash, `HEAD` and anything
 * that is not a branch name (a revision expression, an empty string) fail the repository's scan.
 */
async function branchRef(branch: unknown): Promise<string> {
  const refused = new Error(`default branch ${JSON.stringify(String(branch)).slice(0, 120)} is not a branch name`);
  if (typeof branch !== 'string' || branch === '' || branch.startsWith('-') || branch === 'HEAD') throw refused;
  const ref = `refs/heads/${branch}`;
  try {
    await exec('git', ['check-ref-format', ref]);
  } catch {
    throw refused;
  }
  return ref;
}

async function ensureClone(dir: string, owner: string, name: string): Promise<void> {
  let exists = false;
  try { await fs.stat(path.join(dir, 'objects')); exists = true; } catch { /* not yet */ }
  const url = `https://x-access-token:${env.githubToken}@github.com/${owner}/${name}.git`;
  if (!exists) {
    await fs.mkdir(dir, { recursive: true });
    await exec('git', ['clone', '--bare', '--filter=blob:none', '--', url, dir], { maxBuffer: 64 * 1024 * 1024 });
  } else {
    await exec('git', ['--git-dir', dir, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

async function gitOut(gitDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--git-dir', gitDir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// `ref` is a full ref name from branchRef(), always after --end-of-options.
async function commitStats(gitDir: string, ref: string): Promise<{
  total: number; last30d: number; authors30d: number; head: string;
}> {
  const head = (await gitOut(gitDir, ['rev-parse', '--verify', '--end-of-options', ref])).trim();
  const total = parseInt((await gitOut(gitDir, ['rev-list', '--count', '--end-of-options', ref])).trim(), 10) || 0;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last30d = parseInt(
    (await gitOut(gitDir, ['rev-list', '--count', `--since=${since}`, '--end-of-options', ref])).trim(),
    10,
  ) || 0;
  const authorLines = (await gitOut(gitDir, ['log', `--since=${since}`, '--format=%ae', '--end-of-options', ref]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const authors30d = new Set(authorLines).size;
  return { total, last30d, authors30d, head };
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

/** Resolves when the child exits with 0; a failure carries the last line it wrote to stderr. */
function finished(child: ChildProcess, what: string): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${what} failed: ${lastLine(stderr) || (signal ? `stopped by ${signal}` : `exit code ${code}`)}`));
    });
  });
}

/** Unpacks `ref` of a bare repository into `dest`: git archive piped into tar by this process. */
async function unpack(gitDir: string, ref: string, dest: string): Promise<void> {
  const archive = spawn('git', ['--git-dir', gitDir, 'archive', '--format=tar', '--end-of-options', ref], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
  const results = await Promise.allSettled([
    finished(archive, 'git archive'),
    finished(tar, 'tar'),
    pipeline(archive.stdout, tar.stdin),
  ]);
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
  if (failures.length) throw new Error(failures.join('; '));
}

/** Newlines in the regular files under `dir`. Symlinks are neither followed nor counted. */
async function countLines(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await countLines(full);
    else if (e.isFile()) {
      try {
        for await (const chunk of createReadStream(full) as AsyncIterable<Buffer>) {
          for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) total++;
        }
      } catch { /* unreadable file: not counted */ }
    }
  }
  return total;
}

// Best-effort LOC counter using `scc` if installed; falls back to line count by extension.
async function locByLanguage(gitDir: string, ref: string): Promise<Array<{
  language: string; files: number; lines: number; code: number; comments: number; blanks: number;
}>> {
  // Materialize the tree of the default branch into a tmp dir so scc/cloc can read it.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loc-'));
  try {
    await unpack(gitDir, ref, tmp);
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
      const total = await countLines(tmp).catch(() => 0);
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
        // Names are checked before anything is created or fetched.
        const dir = cloneDir(r);
        const branchRow = await pool.query<{ default_branch: string }>(
          `SELECT default_branch FROM repos WHERE id=$1`, [r.id],
        );
        const ref = await branchRef(branchRow.rows[0]?.default_branch ?? 'main');
        await ensureClone(dir, r.owner, r.name);
        const stats = await commitStats(dir, ref);
        await pool.query(
          `INSERT INTO commit_snapshots (repo_id, total_commits, commits_last_30d, authors_last_30d, head_sha)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (repo_id, ts) DO NOTHING`,
          [r.id, stats.total, stats.last30d, stats.authors30d, stats.head],
        );
        const langs = await locByLanguage(dir, ref);
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
