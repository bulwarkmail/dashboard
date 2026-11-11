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
process.env.GITHUB_ORG = 'acme';
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
  makeRemote('legacy', 'main');
  makeRemote('private', 'main');
  makeRemote('anon', 'main');
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
const { gitEnv, runGitScan } = await import('./git.js');

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

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? (entry as any).path, entry.name));
}

const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

test('a clone that fails leaves the token out of the run record and the log', async (t) => {
  const { run, log } = await scan(t, [{ name: 'missing', branch: 'main' }]);
  assert.ok(run, 'the run was recorded');
  assert.equal(bound(run, 'repos_err'), 1, 'the clone failed, as arranged');
  assert.ok(!JSON.stringify(run.params).includes(TOKEN), `collector_runs.error holds the GitHub token: ${String(bound(run, 'error')).replace(TOKEN, '<token>').slice(0, 160)}`);
  assert.ok(!log.includes(TOKEN), 'the log holds the GitHub token');
  // Not in another form either.
  assert.ok(!JSON.stringify(run.params).includes(BASIC) && !log.includes(BASIC), 'the credential is there base64 encoded');
});

test('a clone keeps the token out of every file of the repository on disk', async (t) => {
  const { run } = await scan(t, [{ name: 'clean', branch: 'main' }]);
  assert.equal(bound(run, 'repos_ok'), 1, 'the scan of the clean repository worked');
  const files = filesUnder(path.join(reposDir, 'acme', 'clean'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(!fs.readFileSync(file, 'latin1').includes(TOKEN), `${path.basename(file)} of the bare clone holds the GitHub token`);
  }
});

test('a clone made by an earlier version loses the token from its remote URL at the next scan', async (t) => {
  const dir = path.join(reposDir, 'acme', 'legacy');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', path.join(remote, 'acme', 'legacy.git'), dir], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', dir, 'config', 'remote.origin.url', `https://x-access-token:${TOKEN}@github.com/acme/legacy.git`], { stdio: 'pipe' });
  const { run } = await scan(t, [{ name: 'legacy', branch: 'main' }]);
  assert.equal(bound(run, 'repos_ok'), 1, 'the scan of the existing clone worked');
  assert.ok(!fs.readFileSync(path.join(dir, 'config'), 'utf8').includes(TOKEN), 'the old clone still has the token in its config');
});

test('a fetch that fails on an existing clone stores the repository and git\'s message line, without the token', async (t) => {
  // An existing clone whose repository is gone, with the credential in its remote URL.
  const dir = path.join(reposDir, 'acme', 'gone');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', dir], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', dir, 'remote', 'add', 'origin', `https://x-access-token:${TOKEN}@github.com/acme/gone.git`], { stdio: 'pipe' });
  const { run, log } = await scan(t, [{ name: 'gone', branch: 'main' }]);
  assert.equal(bound(run, 'repos_err'), 1, 'the fetch failed, as arranged');
  for (const text of [JSON.stringify(run?.params), log]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(BASIC), 'the token is in the run record or the log');
  }
  const error = String(bound(run, 'error'));
  assert.match(error, /^acme\/gone: git fetch failed: /);
  assert.ok(!error.includes('\n') && error.length < 400, `more than one line of git's output was stored: ${JSON.stringify(error.slice(0, 200))}`);
});

test('a new clone can be read by the collector\'s own account only', { skip: process.platform === 'win32' }, async (t) => {
  const dir = path.join(reposDir, 'acme', 'private');
  const { run } = await scan(t, [{ name: 'private', branch: 'main' }]);
  assert.equal(bound(run, 'repos_ok'), 1);
  const entries = [dir, ...fs.readdirSync(dir, { recursive: true }).map((p) => path.join(dir, String(p)))];
  for (const entry of entries) {
    const mode = fs.lstatSync(entry).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${path.relative(reposDir, entry)} has mode ${mode.toString(8)}`);
  }
});

test('git gets the token as a header for github.com only, after the config entries it already has', () => {
  const token = 'ghp_FAKE+token/with=chars0000';
  const parent: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'kept' };
  const config = (childEnv: NodeJS.ProcessEnv, ...args: string[]) =>
    execFileSync('git', ['config', ...args], { env: childEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
  const withToken = gitEnv(token, parent);
  assert.equal(
    config(withToken, '--get-urlmatch', 'http.extraheader', 'https://github.com/acme/clean.git'),
    `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  );
  assert.equal(config(withToken, '--get', 'user.name'), 'kept', 'the config entry from the parent environment was replaced');
  assert.throws(() => config(withToken, '--get-urlmatch', 'http.extraheader', 'https://example.org/acme/clean.git'), 'the header is sent to other hosts');
  assert.equal(withToken.GIT_CONFIG_GLOBAL, parent.GIT_CONFIG_GLOBAL, 'the parent environment was not passed on');
  // git follows no redirect, with or without a token, so the header never goes to another host.
  assert.equal(config(withToken, '--get', 'http.followRedirects'), 'false');
  // No token: no header, public repositories clone without one.
  const anonymous = gitEnv('', parent);
  assert.equal(config(anonymous, '--get', 'http.followRedirects'), 'false');
  assert.equal(config(anonymous, '--get', 'user.name'), 'kept');
  assert.ok(!Object.values(anonymous).some((v) => v?.includes('Authorization')), 'a header was added without a token');
});

test('without a token a public repository is still cloned, with no credential at all', async (t) => {
  const { env } = await import('./env.js');
  t.after(() => { env.githubToken = TOKEN; });
  env.githubToken = '';
  const { run } = await scan(t, [{ name: 'anon', branch: 'main' }]);
  assert.equal(bound(run, 'repos_ok'), 1, 'the public repository was not cloned without a token');
  assert.ok(!fs.readFileSync(path.join(reposDir, 'acme', 'anon', 'config'), 'utf8').includes('x-access-token'));
});

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
