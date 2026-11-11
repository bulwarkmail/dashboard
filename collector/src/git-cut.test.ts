// Error text is cleaned before it is cut. git is replaced by a script that fails a fetch with one long
// "fatal:" line holding a URL with the credential, placed so that the credential crosses character 300.
// Cut first, the credential would lose the "@" the URL rule looks for and stay in part.
// Linux only (shell script as git), like git-scan.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE0000';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'));
const reposDir = path.join(work, 'repos');
const bin = path.join(work, 'bin');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// "fatal: " + padding + " https://x-access-token:<token>@github.com/...": the token starts at character
// 270, so a cut at 300 would keep its first 30 characters and drop the "@".
const padding = 'x'.repeat(270 - 'fatal: '.length - ' https://x-access-token:'.length);
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'git'), [
  '#!/bin/sh',
  'for a in "$@"; do',
  `  if [ "$a" = fetch ]; then echo "fatal: ${padding} https://x-access-token:$GITHUB_TOKEN@github.com/acme/clean.git/ is not available" >&2; exit 128; fi`,
  'done',
  `exec ${realGit} "$@"`,
  '',
].join('\n'), { mode: 0o755 });

process.env.GITHUB_TOKEN = TOKEN;
process.env.GITHUB_ORG = 'acme';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = reposDir;
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.https_proxy = 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'gitconfig');
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.GIT_CONFIG_COUNT;
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

// An existing clone, so the scan goes to the fetch.
execFileSync(realGit, ['init', '-q', '--bare', path.join(reposDir, 'acme', 'clean')], { stdio: 'pipe' });
execFileSync(realGit, ['--git-dir', path.join(reposDir, 'acme', 'clean'), 'remote', 'add', 'origin', 'https://github.com/acme/clean.git'], { stdio: 'pipe' });

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const { pool } = await import('./db.js');
const { log } = await import('./log.js');
const { runGitScan } = await import('./git.js');

test('a credential that crosses the 300-character cut of git\'s message is not stored in part', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const rows = [{ id: 'acme/clean', owner: 'acme', name: 'clean', default_branch: 'main' }];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/\bFROM repos\b/.test(sql)) return { rows, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  let lines = '';
  for (const level of ['info', 'warn', 'error'] as const) {
    t.mock.method(log, level, (msg: string, fields?: Record<string, unknown>) => { lines += `${msg} ${JSON.stringify(fields ?? {})}\n`; });
  }
  await runGitScan();
  const run = calls.find((c) => c.sql.startsWith('UPDATE collector_runs'));
  const stored = String(run?.params[4]);
  assert.match(stored, /git fetch failed/);
  // No 12 characters in a row of the token, anywhere.
  for (const text of [stored, lines]) {
    for (let i = 0; i + 12 <= TOKEN.length; i++) {
      const piece = TOKEN.slice(i, i + 12);
      assert.ok(!text.includes(piece), `the stored error or the log holds part of the token: ...${text.slice(Math.max(0, text.indexOf(piece) - 30), text.indexOf(piece)).replace(/x{20,}/, 'xxx')}<${text.indexOf(piece) === -1 ? '' : `${text.length - text.indexOf(piece)} characters of the token follow`}>`);
    }
  }
});
