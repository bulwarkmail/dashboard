// The limits of one repository's scan: a time limit after which its programs are stopped, and caps on
// the bytes and entries unpacked for the line count. The limits are set low through the environment.
// git is a shim that can be told to hang in one subcommand. Linux only, like git-scan.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-limits-'));
const remote = path.join(work, 'remote');
const reposDir = path.join(work, 'repos');
const gitConfig = path.join(work, 'gitconfig');
const bin = path.join(work, 'bin');
const tmp = path.join(work, 'tmp');
const pidFile = path.join(work, 'pids');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();

const DEADLINE_MS = 3000;
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
// git that hangs (without output) in the subcommand named by HANG_ON; git and tar note their process ids.
fs.writeFileSync(path.join(bin, 'git'), [
  '#!/bin/sh',
  'for a in "$@"; do',
  '  if [ -n "$HANG_ON" ] && [ "$a" = "$HANG_ON" ]; then echo "git $$" >> "$PID_FILE"; exec sleep 60; fi',
  'done',
  `exec ${realGit} "$@"`,
  '',
].join('\n'), { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'tar'), ['#!/bin/sh', 'echo "tar $$" >> "$PID_FILE"', `exec ${realTar} "$@"`, ''].join('\n'), { mode: 0o755 });
fs.writeFileSync(gitConfig, `[url "file://${remote}/"]\n\tinsteadOf = https://github.com/\n`);

process.env.GITHUB_TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE0000';
process.env.GITHUB_ORG = 'acme';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = reposDir;
process.env.COLLECTOR_SCAN_DEADLINE_MS = String(DEADLINE_MS);
process.env.COLLECTOR_UNPACK_MAX_BYTES = String(1024 * 1024);
process.env.COLLECTOR_UNPACK_MAX_ENTRIES = '20';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.https_proxy = 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.TMPDIR = tmp;
process.env.PID_FILE = pidFile;
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.GIT_CONFIG_COUNT;
delete process.env.HANG_ON;

function makeRemote(name: string, files: Record<string, string>): void {
  const src = path.join(work, `src-${name}`);
  const git = (...args: string[]) => execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args], { cwd: src, stdio: 'pipe' });
  fs.mkdirSync(src, { recursive: true });
  git('init', '-q');
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(src, file), content);
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  fs.mkdirSync(path.join(remote, 'acme'), { recursive: true });
  execFileSync(realGit, ['clone', '-q', '--bare', src, path.join(remote, 'acme', `${name}.git`)], { stdio: 'pipe' });
}

before(() => {
  makeRemote('small', { 'a.ts': 'export const a = 1;\n' });
  makeRemote('hangs', { 'a.ts': 'export const a = 1;\n' });
  makeRemote('big', { 'big.ts': 'x\n'.repeat(1024 * 1024) });
  const many: Record<string, string> = {};
  for (let i = 0; i < 30; i++) many[`f${i}.ts`] = `export const v${i} = ${i};\n`;
  makeRemote('many', many);
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const { pool } = await import('./db.js');
const { log } = await import('./log.js');
const { runGitScan } = await import('./git.js');

interface Result { ok: number; err: number; error: string | null; lines: number; ms: number }

async function scan(t: import('node:test').TestContext, name: string): Promise<Result> {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const rows = [{ id: `acme/${name}`, owner: 'acme', name, default_branch: 'main' }];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/\bFROM repos\b/.test(sql)) return { rows, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  for (const level of ['info', 'warn', 'error'] as const) t.mock.method(log, level, () => undefined);
  const start = Date.now();
  await runGitScan();
  const ms = Date.now() - start;
  t.mock.restoreAll();
  const run = calls.find((c) => c.sql.startsWith('UPDATE collector_runs'));
  // UPDATE collector_runs SET finished_at=now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id=$1
  const lines = calls.filter((c) => c.sql.startsWith('INSERT INTO loc_snapshots')).reduce((sum, c) => sum + Number(c.params[3]), 0);
  return { ok: Number(run?.params[2]), err: Number(run?.params[3]), error: (run?.params[4] as string | null) ?? null, lines, ms };
}

/** Process ids the shims noted since the last call, and whether each is still running. */
function noted(): Array<{ program: string; pid: number; running: boolean }> {
  const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '';
  fs.rmSync(pidFile, { force: true });
  return text.split('\n').filter(Boolean).map((line) => {
    const [program, pid] = line.split(' ');
    let running = true;
    try { process.kill(Number(pid), 0); } catch { running = false; }
    return { program, pid: Number(pid), running };
  });
}

function leftoverTemp(): string[] {
  return fs.readdirSync(tmp).filter((n) => n.startsWith('loc-'));
}

test('a repository within the limits is scanned as before', async (t) => {
  const result = await scan(t, 'small');
  assert.equal(result.ok, 1, String(result.error));
  assert.equal(result.lines, 1);
  noted();
});

test('a clone that hangs is stopped at the time limit and the repository fails with a plain message', { timeout: 120_000 }, async (t) => {
  noted();
  process.env.HANG_ON = 'clone';
  t.after(() => { delete process.env.HANG_ON; });
  const result = await scan(t, 'hangs');
  assert.equal(result.err, 1);
  assert.equal(result.error, 'acme/hangs: stopped after 3 s, the time limit for one repository');
  assert.ok(result.ms < DEADLINE_MS + 10_000, `the scan took ${result.ms} ms`);
  const pids = noted();
  assert.ok(pids.some((p) => p.program === 'git'), 'the clone did not start');
  assert.deepEqual(pids.filter((p) => p.running), [], 'a program is still running');
});

test('an unpack that hangs stops git archive and tar at the time limit', { timeout: 120_000 }, async (t) => {
  // The clone of "small" exists from the first test; now git archive hangs while tar waits for it.
  noted();
  process.env.HANG_ON = 'archive';
  t.after(() => { delete process.env.HANG_ON; });
  const result = await scan(t, 'small');
  assert.equal(result.err, 1);
  assert.equal(result.error, 'acme/small: stopped after 3 s, the time limit for one repository');
  assert.ok(result.ms < DEADLINE_MS + 10_000, `the scan took ${result.ms} ms`);
  const pids = noted();
  assert.deepEqual(pids.map((p) => p.program).sort(), ['git', 'tar']);
  assert.deepEqual(pids.filter((p) => p.running), [], 'a program is still running');
  assert.deepEqual(leftoverTemp(), [], 'the temp folder was left behind');
});

test('a tree larger than the byte cap is not unpacked any further and the repository fails', async (t) => {
  const result = await scan(t, 'big');
  assert.equal(result.err, 1, 'a tree over the cap was counted');
  assert.equal(result.error, 'acme/big: the tree is larger than 1 MiB, not counted');
  assert.equal(result.lines, 0);
  assert.deepEqual(noted().filter((p) => p.running), [], 'a program is still running');
  assert.deepEqual(leftoverTemp(), [], 'the temp folder was left behind');
});

test('a tree with more entries than the cap is not unpacked any further and the repository fails', async (t) => {
  const result = await scan(t, 'many');
  assert.equal(result.err, 1, 'a tree over the cap was counted');
  assert.equal(result.error, 'acme/many: the tree has more than 20 entries, not counted');
  assert.deepEqual(noted().filter((p) => p.running), [], 'a program is still running');
  assert.deepEqual(leftoverTemp(), [], 'the temp folder was left behind');
});
