// The unpack step succeeds when tar is done before git archive has exited: both programs exit 0,
// so the repository is counted. git archive is made to stay alive 300 ms after its output is
// complete, which makes tar finish first every time. Linux only, like git-scan.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-race-'));
const remote = path.join(work, 'remote');
const reposDir = path.join(work, 'repos');
const gitConfig = path.join(work, 'gitconfig');
const bin = path.join(work, 'bin');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// A git that behaves like git, except that `git ... archive` stays alive for 300 ms after its output is complete.
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'git'), [
  '#!/bin/sh',
  'for a in "$@"; do',
  `  if [ "$a" = archive ]; then ${realGit} "$@"; rc=$?; sleep 0.3; exit $rc; fi`,
  'done',
  `exec ${realGit} "$@"`,
  '',
].join('\n'), { mode: 0o755 });

const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE0000';
fs.writeFileSync(gitConfig, `[url "file://${remote}/"]\n\tinsteadOf = https://github.com/\n`);
process.env.GITHUB_TOKEN = TOKEN;
process.env.GITHUB_ORG = 'acme';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = reposDir;
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.https_proxy = 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.GIT_CONFIG_COUNT;

before(() => {
  const src = path.join(work, 'src');
  const git = (...args: string[]) => execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args], { cwd: src, stdio: 'pipe' });
  fs.mkdirSync(src, { recursive: true });
  git('init', '-q');
  fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  fs.mkdirSync(path.join(remote, 'acme'), { recursive: true });
  execFileSync(realGit, ['clone', '-q', '--bare', src, path.join(remote, 'acme', 'clean.git')], { stdio: 'pipe' });
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const { pool } = await import('./db.js');
const { log } = await import('./log.js');
const { runGitScan } = await import('./git.js');

test('the line count works when tar is done before git archive has exited', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const rows = [{ id: 'acme/clean', owner: 'acme', name: 'clean', default_branch: 'main' }];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/\bFROM repos\b/.test(sql)) return { rows, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  for (const level of ['info', 'warn', 'error'] as const) t.mock.method(log, level, () => undefined);
  await runGitScan();
  const run = calls.find((c) => c.sql.startsWith('UPDATE collector_runs'));
  // UPDATE collector_runs SET finished_at=now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id=$1
  assert.equal(run?.params[4], null, `the scan of an ordinary repository failed: ${String(run?.params[4])}`);
  assert.equal(run?.params[2], 1);
  const lines = calls.filter((c) => c.sql.startsWith('INSERT INTO loc_snapshots')).reduce((sum, c) => sum + Number(c.params[3]), 0);
  assert.equal(lines, 1, 'the repository has one line');
});
