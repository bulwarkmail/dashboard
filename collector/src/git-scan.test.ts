// Runs the real runGitScan() against local bare repositories, with the database and the log captured.
// Linux only (the scan uses tar), like the collector itself. Needs git.
//
// github.com is mapped to the local repositories through a git config file (GIT_CONFIG_GLOBAL), so
// the scan has to pass the parent's environment on to git. Nothing here leaves the machine: the token
// is a fake, and https_proxy points at a closed port.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE0000';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-scan-'));
const remote = path.join(work, 'remote');
const reposDir = path.join(work, 'repos');
const marker = path.join(work, 'marker-file');
const gitConfig = path.join(work, 'gitconfig');
const outside = path.join(work, 'outside');

// Valid git branch names (`git check-ref-format --branch` accepts each), one per way a shell reads text.
const SHELL_BRANCHES = [
  'main;touch${IFS}$PWN_MARKER',
  "x';touch${IFS}$PWN_MARKER;'",
  'x";touch${IFS}$PWN_MARKER;"',
  'main|touch${IFS}$PWN_MARKER',
  'main&&touch${IFS}$PWN_MARKER',
  'x$(touch${IFS}$PWN_MARKER)',
  'x`touch${IFS}$PWN_MARKER`',
];

fs.writeFileSync(gitConfig, [
  `[url "file://${remote}/"]`,
  '\tinsteadOf = https://github.com/',
  `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/`,
  '',
].join('\n'));

process.env.GITHUB_TOKEN = TOKEN;
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = reposDir;
process.env.PWN_MARKER = marker;
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.https_proxy = 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = gitConfig;
delete process.env.GIT_CONFIG_COUNT;

function makeRemote(name: string, branch: string, addFiles?: (src: string) => void): void {
  const src = path.join(work, `src-${name}`);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args], { cwd: src, stdio: 'pipe' });
  fs.mkdirSync(src, { recursive: true });
  git('init', '-q');
  fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
  addFiles?.(src);
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  if (branch !== 'main') git('branch', '-m', 'main', branch);
  fs.mkdirSync(path.join(remote, 'acme'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', src, path.join(remote, 'acme', `${name}.git`)], { stdio: 'pipe' });
}

before(() => {
  makeRemote('clean', 'main');
  makeRemote('slashed', 'release/1.x-next');
  makeRemote('dashed', 'x-y');
  SHELL_BRANCHES.forEach((branch, i) => makeRemote(`hostile${i}`, branch));
  // A tree with symlinks to a file and a folder outside it.
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'many.ts'), 'x\n'.repeat(1000));
  fs.writeFileSync(path.join(outside, 'package-lock.json'), '{}\n'.repeat(1000));
  makeRemote('linked', 'main', (src) => {
    fs.symlinkSync(path.join(outside, 'many.ts'), path.join(src, 'out-file.ts'));
    fs.symlinkSync(outside, path.join(src, 'out-dir'));
    fs.symlinkSync(path.join(outside, 'package-lock.json'), path.join(src, 'package-lock.json'));
  });
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const { pool } = await import('./db.js');
const { log } = await import('./log.js');
const { runGitScan } = await import('./git.js');

interface Seen { sql: string; params: unknown[] }
interface Repo { name: string; branch: string; id?: string; owner?: string }

/** The parameter bound to `column`, for `UPDATE ... SET column=$n` and `INSERT INTO t (a, b) VALUES ($1, $2)`. */
function bound(call: Seen | undefined, column: string): unknown {
  if (!call) return undefined;
  const set = new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`).exec(call.sql);
  if (set) return call.params[Number(set[1]) - 1];
  const insert = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(call.sql);
  if (!insert) return undefined;
  const at = insert[1].split(',').map((s) => s.trim()).indexOf(column);
  const placeholder = /\$(\d+)/.exec(insert[2].split(',')[at] ?? '');
  return placeholder ? call.params[Number(placeholder[1]) - 1] : undefined;
}

/** Runs one scan over `repos` with the database and the log captured. */
async function scan(t: import('node:test').TestContext, repos: Repo[]): Promise<{ calls: Seen[]; log: string; run: Seen | undefined }> {
  const calls: Seen[] = [];
  const idOf = (r: Repo) => r.id ?? `acme/${r.name}`;
  const row = (r: Repo) => ({ id: idOf(r), owner: r.owner ?? 'acme', name: r.name, default_branch: r.branch });
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/SELECT[^;]*\bFROM repos\b/.test(sql) && !/WHERE id\s*=\s*\$1/.test(sql)) {
      return { rows: repos.map(row), rowCount: repos.length };
    }
    if (/SELECT[^;]*\bFROM repos\b/.test(sql)) {
      const repo = repos.find((r) => idOf(r) === params[0]);
      return { rows: repo ? [row(repo)] : [], rowCount: repo ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  // The logger's own methods, not stdout: the test runner reports through that.
  let lines = '';
  for (const level of ['info', 'warn', 'error'] as const) {
    t.mock.method(log, level, (msg: string, fields?: Record<string, unknown>) => { lines += `${msg} ${JSON.stringify(fields ?? {})}\n`; });
  }
  await runGitScan();
  return { calls, log: lines, run: calls.find((c) => c.sql.startsWith('UPDATE collector_runs')) };
}

for (const [i, branch] of SHELL_BRANCHES.entries()) {
  test(`a default branch named ${JSON.stringify(branch)} runs nothing`, async (t) => {
    fs.rmSync(marker, { force: true });
    const { run } = await scan(t, [{ name: `hostile${i}`, branch }]);
    assert.equal(fs.existsSync(marker), false, 'the branch name was run as a shell command');
    assert.equal(bound(run, 'repos_ok'), 1, 'a valid branch name was not scanned');
  });
}

test('a branch value from the repos table that is a revision expression runs nothing', async (t) => {
  // Not a branch name at all: git resolves it as "the newest commit whose message matches".
  fs.rmSync(marker, { force: true });
  const { run } = await scan(t, [{ name: 'clean', branch: 'main^{/.|x;touch $PWN_MARKER;x}' }]);
  assert.equal(fs.existsSync(marker), false, 'text from the repos table was run as a shell command');
  assert.equal(bound(run, 'repos_ok'), 0, 'a value that is no branch name was scanned as if it were one');
});

test('a repo id from the repos table with a quote in it runs nothing and stays inside the repos folder', async (t) => {
  fs.rmSync(marker, { force: true });
  for (const id of ["acme/x';touch $PWN_MARKER;'", 'acme/../../escaped', '../escaped', 'acme/x y', 'acme/clean/../../../escaped']) {
    await scan(t, [{ name: 'clean', branch: 'main', id }]);
    assert.equal(fs.existsSync(marker), false, `repo id ${JSON.stringify(id)} was run as a shell command`);
    assert.equal(fs.existsSync(path.join(work, 'escaped')), false, `repo id ${JSON.stringify(id)} made a clone outside the repos folder`);
    assert.equal(fs.existsSync(path.join(reposDir, '..', '..', 'escaped')), false);
  }
});

test('a branch value that starts with a dash is not read as an option', async (t) => {
  // No branch can be called this (git refuses a leading dash), so it can only come from the table.
  // Read as an option, git would write the file.
  const written = path.join(work, 'written-by-option');
  await scan(t, [{ name: 'clean', branch: `--output=${written}` }]);
  assert.equal(fs.existsSync(written), false);
});

test('a branch value that is no branch name fails that repository before anything is cloned', async (t) => {
  for (const [i, branch] of ['main x', 'main\nx', 'HEAD', '-x', '', 'main..x', 'main.lock'].entries()) {
    const id = `acme/refused-branch-${i}`;
    const { run } = await scan(t, [{ name: 'clean', branch, id }]);
    assert.equal(bound(run, 'repos_err'), 1, `${JSON.stringify(branch)} was scanned as a branch`);
    assert.equal(fs.existsSync(path.join(reposDir, id)), false, `${JSON.stringify(branch)}: a clone was made before the name was checked`);
  }
});

test('an owner or name with a colon or an at sign fails that repository before anything is cloned', async (t) => {
  const names = [
    { owner: 'ac:me', name: 'clean' },
    { owner: 'acme@github.com', name: 'clean' },
    { owner: 'acme', name: 'x@y' },
    { owner: 'acme', name: 'x:y' },
  ];
  for (const [i, { owner, name }] of names.entries()) {
    const id = `acme/refused-name-${i}`;
    const { run } = await scan(t, [{ owner, name, branch: 'main', id }]);
    assert.equal(bound(run, 'repos_err'), 1, `${owner}/${name} was scanned`);
    assert.equal(fs.existsSync(path.join(reposDir, id)), false, `${owner}/${name}: a clone was made before the names were checked`);
  }
});

test('a branch with a dash inside its name is scanned', async (t) => {
  const { run } = await scan(t, [{ name: 'dashed', branch: 'x-y' }]);
  assert.equal(bound(run, 'repos_ok'), 1);
});

test('the line count does not follow symlinks out of the unpacked tree', async (t) => {
  const { calls, run } = await scan(t, [{ name: 'linked', branch: 'main' }]);
  assert.equal(bound(run, 'repos_ok'), 1, 'the scan of the repository with symlinks worked');
  const lines = calls
    .filter((c) => c.sql.startsWith('INSERT INTO loc_snapshots') && bound(c, 'repo_id') === 'acme/linked')
    .reduce((sum, c) => sum + Number(bound(c, 'lines')), 0);
  assert.ok(lines > 0 && lines < 1000, `${lines} lines counted: files behind the symlinks were read`);
  assert.ok(fs.existsSync(path.join(outside, 'many.ts')) && fs.existsSync(path.join(outside, 'package-lock.json')), 'a file behind a symlink was removed');
});

test('the scan still counts commits and lines for ordinary repositories', async (t) => {
  const { calls, run } = await scan(t, [{ name: 'clean', branch: 'main' }, { name: 'slashed', branch: 'release/1.x-next' }]);
  assert.equal(bound(run, 'repos_ok'), 2, 'both repositories were scanned');
  for (const id of ['acme/clean', 'acme/slashed']) {
    const commits = calls.find((c) => c.sql.startsWith('INSERT INTO commit_snapshots') && bound(c, 'repo_id') === id);
    assert.equal(bound(commits, 'total_commits'), 1, `one commit counted for ${id}`);
    assert.ok(calls.some((c) => c.sql.startsWith('INSERT INTO loc_snapshots') && bound(c, 'repo_id') === id), `no line counts were stored for ${id}`);
  }
});
