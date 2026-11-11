import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pool } from './db.js';
import { env } from './env.js';
import { errorText, log } from './log.js';

// Every program is started with an argument list, never through a shell: repository ids, owners,
// names and branch names come from GitHub and from the repos table.

// Limits of one repository's scan. The defaults are in env.ts; the environment can change them.
/** Time one repository's scan may take (fetch, counts, unpack, line count); its programs are stopped then. */
const SCAN_DEADLINE_MS = env.scanDeadlineMs;
/** Bytes of tar stream unpacked for one repository's line count, at most. */
const UNPACK_MAX_BYTES = env.unpackMaxBytes;
/** Entries (files, folders, links) unpacked for one repository's line count, at most. */
const UNPACK_MAX_ENTRIES = env.unpackMaxEntries;
/** Time a stopped program gets between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 5000;

// Each program runs in a process group of its own, so stopping it also stops what it started
// (git's transport helpers, for example).
const OWN_GROUP = process.platform !== 'win32';

const stopping = new WeakSet<ChildProcess>();

/**
 * Stops a child and its process group: SIGTERM, then SIGKILL if it is still running after the grace
 * time. Once the program itself has exited, whatever is left in its group (a helper that ignores
 * SIGTERM and may hold the program's output open) is killed at once.
 */
function stop(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null || stopping.has(child)) return;
  stopping.add(child);
  const send = (sig: NodeJS.Signals) => {
    try {
      if (OWN_GROUP) process.kill(-pid, sig);
      else child.kill(sig);
    } catch { /* already gone */ }
  };
  send('SIGTERM');
  const timer = setTimeout(() => send('SIGKILL'), STOP_GRACE_MS);
  timer.unref();
  child.once('exit', () => {
    clearTimeout(timer);
    send('SIGKILL');
  });
}

/** Stops the child when `signal` is aborted (the repository's deadline has passed). */
function stopOnAbort(child: ChildProcess, signal: AbortSignal): void {
  if (signal.aborted) {
    stop(child);
    return;
  }
  const onAbort = () => stop(child);
  signal.addEventListener('abort', onAbort, { once: true });
  const done = () => signal.removeEventListener('abort', onAbort);
  child.once('exit', done);
  child.once('error', done);
}

function describeLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;
}

interface Exit { ok: boolean; message: string }

/** Most of a program's stderr kept for its failure line, in whole lines. */
const STDERR_KEEP = 64 * 1024;

/**
 * Resolves once the child has exited and its output is closed; a failure carries the line of
 * stderr that says what failed. stderr is kept in whole lines only (the newest ones), and a line
 * longer than STDERR_KEEP is dropped, so no line is ever cut before errorText() has cleaned it.
 */
function exited(child: ChildProcess, what: string): Promise<Exit> {
  let stderr = '';
  let skipping = false;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (skipping) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) return;
      chunk = chunk.slice(nl + 1);
      skipping = false;
    }
    stderr += chunk;
    while (stderr.length > STDERR_KEEP) {
      const nl = stderr.indexOf('\n');
      if (nl === -1) {
        stderr = '';
        skipping = true;
        break;
      }
      stderr = stderr.slice(nl + 1);
    }
  });
  return new Promise((resolve) => {
    child.once('error', (e) => resolve({ ok: false, message: `${what} failed: ${e.message}` }));
    child.once('close', (code, signal) => resolve(code === 0
      ? { ok: true, message: '' }
      : { ok: false, message: `${what} failed: ${failureLine(stderr) || (signal ? `stopped by ${signal}` : `exit code ${code}`)}` }));
  });
}

/**
 * Runs a program in a process group of its own and returns what it wrote to stdout. It is stopped
 * when `signal` aborts or its output passes `maxBuffer` bytes. A failure carries the program's own
 * message line, not the command line.
 */
async function run(
  file: string, args: string[], what: string, signal: AbortSignal,
  options: { env?: NodeJS.ProcessEnv; maxBuffer: number },
): Promise<string> {
  const child = spawn(file, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: OWN_GROUP });
  stopOnAbort(child, signal);
  const done = exited(child, what);
  const out: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > options.maxBuffer) {
      if (!tooLarge) stop(child);
      tooLarge = true;
      return;
    }
    out.push(chunk);
  });
  const result = await done;
  if (tooLarge) throw new Error(`${what} failed: its output is larger than ${Math.round(options.maxBuffer / 2 ** 20)} MiB`);
  if (!result.ok) throw new Error(result.message);
  return Buffer.concat(out).toString('utf8');
}

interface RepoRow { id: string; owner: string; name: string; }

function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/**
 * The environment for git: the parent's, plus config entries added after the parent's own
 * GIT_CONFIG_COUNT entries:
 * - `http.followRedirects=false`: git follows no redirect, so its requests (and the header below)
 *   only ever go to the URL the scan built. git would send the header to whatever host a redirect
 *   names, because it matches `http.<url>.*` against the remote URL, not the redirected one.
 * - the GitHub token as an `http.https://github.com/.extraheader` entry. The token is never part of
 *   a URL or an argument, so git neither stores nor prints it. Without a token there is no header
 *   and public repositories are cloned anonymously.
 */
export function gitEnv(token: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...parent, GIT_TERMINAL_PROMPT: '0' };
  const entries: Array<[string, string]> = [['http.followRedirects', 'false']];
  if (token) entries.push(['http.https://github.com/.extraheader', `Authorization: Basic ${basicCredential(token)}`]);
  const count = Number(parent.GIT_CONFIG_COUNT || 0);
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = key;
    out[`GIT_CONFIG_VALUE_${n + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(n + entries.length);
  return out;
}

/** The token in the forms git could print it in, for errorText(). */
function tokenForms(): string[] {
  return env.githubToken ? [env.githubToken, basicCredential(env.githubToken)] : [];
}

/** Runs git. A failure carries git's own message line, not the command line. */
async function git(args: string[], what: string, signal: AbortSignal, maxBuffer = 256 * 1024 * 1024): Promise<string> {
  return run('git', args, `git ${what}`, signal, { env: gitEnv(env.githubToken), maxBuffer });
}

// Owner and repository names as GitHub allows them.
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

function isGithubName(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_NAME.test(value) && value !== '.' && value !== '..';
}

/**
 * Where a row's repository is cloned to (`<reposDir>/<owner>/<name>`) and from
 * (`https://github.com/<owner>/<name>.git`). Throws, before anything becomes a path or part of a
 * URL, when the id, owner or name is not a GitHub name, when the owner is not the configured
 * organisation (compared without case, as GitHub does), or when the id is not that owner and name:
 * the repos table can be written by others, so a row may only name a repository of the organisation.
 */
function cloneTarget(r: RepoRow): { dir: string; url: string } {
  const parts = typeof r.id === 'string' ? r.id.split('/') : [];
  if (parts.length !== 2 || !parts.every(isGithubName)) throw new Error('repository id is not <owner>/<name>');
  if (!isGithubName(r.owner) || !isGithubName(r.name)) throw new Error('owner or name is not a GitHub name');
  if (r.owner.toLowerCase() !== env.githubOrg.toLowerCase()) {
    throw new Error(`owner is not the configured organisation (${env.githubOrg})`);
  }
  if (r.id !== `${r.owner}/${r.name}`) throw new Error('repository id does not match the row\'s owner and name');
  const root = path.resolve(env.reposDir);
  const dir = path.resolve(root, parts[0], parts[1]);
  const rel = path.relative(root, dir);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('clone directory is outside the repos folder');
  }
  return { dir, url: `https://github.com/${r.owner}/${r.name}.git` };
}

/**
 * `refs/heads/<branch>` once git's ref-name rules accept it. A leading dash, `HEAD` and anything
 * that is not a branch name (a revision expression, an empty string) fail the repository's scan.
 */
async function branchRef(branch: unknown, signal: AbortSignal): Promise<string> {
  // The value is quoted whole; errorText() cleans the message and then cuts it.
  const refused = new Error(`default branch ${JSON.stringify(String(branch))} is not a branch name`);
  if (typeof branch !== 'string' || branch === '' || branch.startsWith('-') || branch === 'HEAD') throw refused;
  const ref = `refs/heads/${branch}`;
  try {
    await git(['check-ref-format', ref], 'check-ref-format', signal);
  } catch {
    throw refused;
  }
  return ref;
}

async function ensureClone(dir: string, url: string, signal: AbortSignal): Promise<void> {
  let exists = false;
  try { await fs.stat(path.join(dir, 'objects')); exists = true; } catch { /* not yet */ }
  if (!exists) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await git(['clone', '--bare', '--filter=blob:none', '--', url, dir], 'clone', signal, 64 * 1024 * 1024);
  } else {
    // The plain URL is written before every fetch, so a clone whose remote URL holds a credential
    // loses it before git reads it.
    await git(['--git-dir', dir, 'config', '--replace-all', 'remote.origin.url', url], 'config', signal);
    await git(['--git-dir', dir, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], 'fetch', signal, 64 * 1024 * 1024);
  }
}

async function gitOut(gitDir: string, args: string[], signal: AbortSignal): Promise<string> {
  return git(['--git-dir', gitDir, ...args], args[0], signal);
}

// `ref` is a full ref name from branchRef(), always after --end-of-options.
async function commitStats(gitDir: string, ref: string, signal: AbortSignal): Promise<{
  total: number; last30d: number; authors30d: number; head: string;
}> {
  const head = (await gitOut(gitDir, ['rev-parse', '--verify', '--end-of-options', ref], signal)).trim();
  const total = parseInt((await gitOut(gitDir, ['rev-list', '--count', '--end-of-options', ref], signal)).trim(), 10) || 0;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last30d = parseInt(
    (await gitOut(gitDir, ['rev-list', '--count', `--since=${since}`, '--end-of-options', ref], signal)).trim(),
    10,
  ) || 0;
  const authorLines = (await gitOut(gitDir, ['log', `--since=${since}`, '--format=%ae', '--end-of-options', ref], signal))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const authors30d = new Set(authorLines).size;
  return { total, last30d, authors30d, head };
}

/**
 * The line of a program's stderr that says what failed: git's fatal or error line, otherwise the
 * last line. Whole: errorText() cleans it first and cuts it after.
 */
function failureLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('fatal:')) ?? lines.find((l) => l.startsWith('error:')) ?? lines.at(-1) ?? '';
}

/** Counts the entries of a tar stream as it passes, from its 512-byte headers. */
class TarEntries {
  count = 0;
  private header = Buffer.alloc(0);
  private skip = 0;

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - at);
        this.skip -= n;
        at += n;
        continue;
      }
      const take = chunk.subarray(at, at + 512 - this.header.length);
      this.header = this.header.length ? Buffer.concat([this.header, take]) : Buffer.from(take);
      at += take.length;
      if (this.header.length < 512) return;
      const header = this.header;
      this.header = Buffer.alloc(0);
      if (header.every((b) => b === 0)) continue; // end of archive
      // Sizes are octal; a binary size (high bit set) is larger than any limit here.
      const size = header[124] & 0x80 ? Infinity : parseInt(header.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8) || 0;
      const type = String.fromCharCode(header[156]);
      // Pax headers ('x', 'g') describe the next entry or the archive; they are no entries themselves.
      if (type !== 'x' && type !== 'g') this.count++;
      this.skip = Math.ceil(size / 512) * 512;
    }
  }
}

/**
 * Unpacks `ref` of a bare repository into `dest`: git archive piped into tar by this process. The
 * clones are partial, so git archive fetches file contents from GitHub and gets the token too.
 *
 * The outcome depends on both exit codes only: tar may finish reading before git archive has
 * exited, and the rest of git's output is then read and dropped so git can exit. When one program
 * fails, or the archive passes UNPACK_MAX_BYTES or UNPACK_MAX_ENTRIES, both are stopped; both are
 * always waited for.
 */
async function unpack(gitDir: string, ref: string, dest: string, signal: AbortSignal): Promise<void> {
  const archive = spawn('git', ['--git-dir', gitDir, 'archive', '--format=tar', '--end-of-options', ref], {
    env: gitEnv(env.githubToken),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: OWN_GROUP,
  });
  const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'], detached: OWN_GROUP });
  stopOnAbort(archive, signal);
  stopOnAbort(tar, signal);
  const archiveExit = exited(archive, 'git archive');
  const tarExit = exited(tar, 'tar');

  let refused: string | null = null;
  let bytes = 0;
  const entries = new TarEntries();
  let tarReading = true;
  const tarGone = () => {
    tarReading = false;
    archive.stdout.resume();
  };
  // EPIPE and the like when tar has exited: its exit code decides, not the write.
  tar.stdin.on('error', tarGone);
  tar.stdin.on('close', tarGone);
  archive.stdout.on('data', (chunk: Buffer) => {
    if (refused) return;
    bytes += chunk.length;
    entries.push(chunk);
    if (bytes > UNPACK_MAX_BYTES || entries.count > UNPACK_MAX_ENTRIES) {
      refused = bytes > UNPACK_MAX_BYTES
        ? `the tree is larger than ${Math.round(UNPACK_MAX_BYTES / 2 ** 20)} MiB, not counted`
        : `the tree has more than ${UNPACK_MAX_ENTRIES} entries, not counted`;
      stop(archive);
      stop(tar);
      return;
    }
    if (tarReading && !tar.stdin.write(chunk)) {
      archive.stdout.pause();
      tar.stdin.once('drain', () => archive.stdout.resume());
    }
  });
  archive.stdout.on('end', () => {
    if (tarReading) tar.stdin.end();
  });

  const [a, t] = await Promise.all([
    archiveExit.then((r) => { if (!r.ok) stop(tar); return r; }),
    tarExit.then((r) => { if (!r.ok) stop(archive); return r; }),
  ]);
  if (refused) throw new Error(refused);
  const failures = [a, t].filter((r) => !r.ok).map((r) => r.message);
  if (failures.length) throw new Error(failures.join('; '));
}

// The unpacked tree is walked with paths as bytes: a file or folder name that is no UTF-8 can still
// be opened, as `find` and `wc` open it.
const SEP = Buffer.from(path.sep);

/** The entries of a folder, with names as bytes. */
function entries(dir: Buffer) {
  return fs.readdir(dir, { withFileTypes: true, encoding: 'buffer' });
}

/** Newlines in the regular files under `dir`. Symlinks are neither followed nor counted. */
async function countLines(dir: Buffer, signal: AbortSignal): Promise<number> {
  let total = 0;
  for (const e of await entries(dir)) {
    if (signal.aborted) throw new Error('stopped');
    const full = Buffer.concat([dir, SEP, e.name]);
    if (e.isDirectory()) total += await countLines(full, signal);
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
async function locByLanguage(gitDir: string, ref: string, signal: AbortSignal): Promise<Array<{
  language: string; files: number; lines: number; code: number; comments: number; blanks: number;
}>> {
  // Materialize the tree of the default branch into a tmp dir so scc/cloc can read it.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loc-'));
  try {
    await unpack(gitDir, ref, tmp, signal);
    // Strip lock files, license text, and other generated/legal files that
    // scc counts as code but aren't meaningfully part of the codebase.
    const stripNames = new Set([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
      'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'composer.lock',
      'go.sum', 'flake.lock',
      'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.txt',
    ]);
    let stripped = 0;
    async function walk(dir: Buffer): Promise<void> {
      for (const e of await entries(dir)) {
        const full = Buffer.concat([dir, SEP, e.name]);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && stripNames.has(e.name.toString())) {
          await fs.rm(full, { force: true });
          stripped++;
        }
      }
    }
    await walk(Buffer.from(tmp)).catch(() => undefined);
    log.info('git.loc.strip', { repo: gitDir, stripped });
    try {
      const stdout = await run('scc', ['--no-cocomo', '--no-complexity', '--format', 'json', tmp], 'scc', signal, {
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
    } catch (e) {
      if (signal.aborted) throw e;
      // Fallback: total lines under all tracked files, language=ALL.
      const total = await countLines(Buffer.from(tmp), signal).catch((err: unknown) => {
        if (signal.aborted) throw err;
        return 0;
      });
      return [{ language: 'ALL', files: 0, lines: total, code: total, comments: 0, blanks: 0 }];
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** One repository: clone or fetch, commit counts, line counts. Its programs are stopped when `signal` aborts. */
async function scanRepository(r: RepoRow, signal: AbortSignal): Promise<void> {
  // Names and the organisation are checked before anything is created, started or fetched.
  const { dir, url } = cloneTarget(r);
  const branchRow = await pool.query<{ default_branch: string }>(
    `SELECT default_branch FROM repos WHERE id=$1`, [r.id],
  );
  const ref = await branchRef(branchRow.rows[0]?.default_branch ?? 'main', signal);
  await ensureClone(dir, url, signal);
  const stats = await commitStats(dir, ref, signal);
  await pool.query(
    `INSERT INTO commit_snapshots (repo_id, total_commits, commits_last_30d, authors_last_30d, head_sha)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (repo_id, ts) DO NOTHING`,
    [r.id, stats.total, stats.last30d, stats.authors30d, stats.head],
  );
  const langs = await locByLanguage(dir, ref, signal);
  if (signal.aborted) throw new Error('stopped');
  for (const l of langs) {
    await pool.query(
      `INSERT INTO loc_snapshots (repo_id, language, files, lines, code, comments, blanks)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (repo_id, ts, language) DO NOTHING`,
      [r.id, l.language, l.files, l.lines, l.code, l.comments, l.blanks],
    );
  }
}

export async function runGitScan(): Promise<void> {
  // Clones hold the content of private repositories: what the scan and git create on disk is
  // readable by this account only (folders 0700, files 0600).
  process.umask(0o077);
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
      // Each repository gets SCAN_DEADLINE_MS; then its programs are stopped and it counts as failed.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), SCAN_DEADLINE_MS);
      try {
        await scanRepository(r, deadline.signal);
        ok++;
      } catch (e) {
        err++;
        const reason = deadline.signal.aborted ? `stopped after ${describeLimit(SCAN_DEADLINE_MS)}, the time limit for one repository` : e;
        // The id comes from the table: cleaned and cut like the message.
        const repo = errorText(String(r.id), tokenForms(), 200);
        const msg = errorText(reason, tokenForms());
        if (!firstError) firstError = `${repo}: ${msg}`;
        log.warn('git.repo_failed', { repo, err: msg });
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    firstError = errorText(e, tokenForms());
    log.error('git.aborted', { err: firstError });
  } finally {
    await pool.query(
      `UPDATE collector_runs SET finished_at=now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id=$1`,
      [runId, total, ok, err, firstError],
    );
    log.info('git.done', { total, ok, err });
  }
}
