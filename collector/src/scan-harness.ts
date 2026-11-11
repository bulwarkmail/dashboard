// Test harness: the real runGitScan() against local bare repositories, database and log captured.
// Linux only. github.com is mapped to local repositories through GIT_CONFIG_GLOBAL (insteadOf).
// A PATH shim records the argument list of every git and tar process the scan starts.
// Each file that imports this gets its own temp folder (TMPDIR), so files running side by side
// don't see each other's unpack folders.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export const TOKEN = 'ghp_FAKEharnessFAKEharnessFAKEharness0';
export const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
export const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-harness-'));
export const remote = path.join(work, 'remote');
export const reposDir = path.join(work, 'repos');
export const argvLog = path.join(work, 'argv.log');
const gitConfig = path.join(work, 'gitconfig');
const bin = path.join(work, 'bin');
const tmp = path.join(work, 'tmp');

const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
for (const [name, real] of [['git', realGit], ['tar', realTar]] as const) {
  fs.writeFileSync(path.join(bin, name), [
    '#!/bin/sh',
    `{ printf '%s\\0' ${name} "$@"; printf '\\036'; } >> "$SCAN_ARGV_LOG"`,
    `exec ${real} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

// SCAN_HARNESS_HTTPS=1: no mapping. github.com then has to resolve to a local HTTPS server (git-token-wire.test.ts).
export const overHttps = process.env.SCAN_HARNESS_HTTPS === '1';
fs.writeFileSync(gitConfig, overHttps ? '' : [
  `[url "file://${remote}/"]`,
  '\tinsteadOf = https://github.com/',
  '',
].join('\n'));

process.env.GITHUB_TOKEN = TOKEN;
process.env.GITHUB_ORG = 'acme';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = reposDir;
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.TMPDIR = tmp;
if (overHttps) { delete process.env.https_proxy; delete process.env.HTTPS_PROXY; process.env.GIT_CONFIG_NOSYSTEM = '1'; }
else process.env.https_proxy = 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCAN_ARGV_LOG = argvLog;
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.GIT_CONFIG_COUNT;

export function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/** A bare repository at remote/<owner>/<name>.git with one commit on `branch`. `build` may add files or objects. */
export function makeRemote(name: string, branch: string, build?: (src: string) => void, owner = 'acme'): string {
  const src = path.join(work, `src-${owner}-${name}`);
  fs.mkdirSync(src, { recursive: true });
  rawGit(src, 'init', '-q');
  fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
  rawGit(src, 'add', '.');
  rawGit(src, 'commit', '-q', '-m', 'one');
  build?.(src);
  if (branch !== 'main') rawGit(src, 'branch', '-m', 'main', branch);
  fs.mkdirSync(path.join(remote, owner), { recursive: true });
  const bare = path.join(remote, owner, `${name}.git`);
  execFileSync(realGit, ['clone', '-q', '--bare', src, bare], { stdio: 'pipe' });
  return src;
}

export const { pool } = await import('./db.js');
export const { log } = await import('./log.js');
export const { gitEnv, runGitScan } = await import('./git.js');
export const { env } = await import('./env.js');

export interface Seen { sql: string; params: unknown[] }
export interface Row { id: string; owner: string; name: string; default_branch: string | null }

export function bound(call: Seen | undefined, column: string): unknown {
  if (!call) return undefined;
  const set = new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`).exec(call.sql);
  if (set) return call.params[Number(set[1]) - 1];
  const insert = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(call.sql);
  if (!insert) return undefined;
  const at = insert[1].split(',').map((s) => s.trim()).indexOf(column);
  const placeholder = /\$(\d+)/.exec(insert[2].split(',')[at] ?? '');
  return placeholder ? call.params[Number(placeholder[1]) - 1] : undefined;
}

export interface ScanResult {
  calls: Seen[];
  log: string;
  run: Seen | undefined;
  ok: number;
  err: number;
  error: string | null;
  /** Argument lists of every git and tar process started during the scan, program name first. */
  argv: string[][];
}

/** One scan over `rows`, taken as they are (every column may be hostile). */
export async function scanRows(t: TestContext, rows: Row[]): Promise<ScanResult> {
  const calls: Seen[] = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/SELECT[^;]*\bFROM repos\b/.test(sql) && !/WHERE id\s*=\s*\$1/.test(sql)) return { rows, rowCount: rows.length };
    if (/SELECT[^;]*\bFROM repos\b/.test(sql)) {
      const row = rows.find((r) => r.id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  let lines = '';
  for (const level of ['info', 'warn', 'error'] as const) {
    t.mock.method(log, level, (msg: string, fields?: Record<string, unknown>) => { lines += `${msg} ${JSON.stringify(fields ?? {})}\n`; });
  }
  fs.rmSync(argvLog, { force: true });
  await runGitScan();
  t.mock.restoreAll();
  const run = calls.find((c) => c.sql.startsWith('UPDATE collector_runs'));
  const argv = fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, 'utf8').split('\x1e').filter(Boolean).map((rec) => rec.split('\0').slice(0, -1))
    : [];
  return {
    calls, log: lines, run, argv,
    ok: Number(bound(run, 'repos_ok')),
    err: Number(bound(run, 'repos_err')),
    error: (bound(run, 'error') as string | null) ?? null,
  };
}

export function row(name: string, branch: string | null, over: Partial<Row> = {}): Row {
  return { id: `acme/${name}`, owner: 'acme', name, default_branch: branch, ...over };
}

/** Every path under `dir`, relative, for before/after comparisons. */
export function listing(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

/** Folders the scan's line count leaves in the temp folder. */
export function leftoverTemp(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('loc-'));
}

export function cleanup(): void {
  fs.rmSync(work, { recursive: true, force: true });
}
