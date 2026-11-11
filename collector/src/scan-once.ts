// One runGitScan() in a process of its own, so that every run can have its own environment (the limits
// are read once, when env.ts is loaded) and can be stopped like the collector. Not a test file: started
// by the tests through scan-process.ts.
//
// Environment: SCAN_WORK (folder with remote/ and gitconfig, made by scan-process.ts), SCAN_ROWS (JSON list
// of rows), SCAN_REPOS (folder for the clones; default <work>/repos), SCAN_GITCONFIG (git's global config
// file; default <work>/gitconfig, which maps github.com to <work>/remote), SCAN_PROXY, SCAN_READY (a file
// written when the scan starts). Prints one line `RESULT <json>` at the end.
import fs from 'node:fs';
import path from 'node:path';

const work = process.env.SCAN_WORK ?? '';
if (!work) throw new Error('SCAN_WORK is not set');
interface Row { id: string; owner: string; name: string; default_branch: string | null }
const rows = JSON.parse(process.env.SCAN_ROWS ?? '[]') as Row[];

process.env.GITHUB_TOKEN ??= 'ghp_FAKEonceFAKEonceFAKEonceFAKEonce0000';
process.env.GITHUB_ORG ??= 'acme';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.COLLECTOR_REPOS_DIR = process.env.SCAN_REPOS ?? path.join(work, 'repos');
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.https_proxy = process.env.SCAN_PROXY ?? 'http://127.0.0.1:9';
process.env.GIT_CONFIG_GLOBAL = process.env.SCAN_GITCONFIG ?? path.join(work, 'gitconfig');
delete process.env.GIT_CONFIG_COUNT;

const { pool } = await import('./db.js');
const { log } = await import('./log.js');
const { runGitScan } = await import('./git.js');

const failed: Array<{ repo: string; err: string }> = [];
const lines: Record<string, number> = {};
const commits: Record<string, unknown[]> = {};
const logged: string[] = [];
let run: unknown[] = [];
(pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (text.includes('INSERT INTO collector_runs')) return { rows: [{ id: 1 }], rowCount: 1 };
  if (/SELECT[^;]*\bFROM repos\b/.test(text) && !/WHERE id\s*=\s*\$1/.test(text)) return { rows, rowCount: rows.length };
  if (/SELECT[^;]*\bFROM repos\b/.test(text)) return { rows: rows.filter((r) => r.id === params[0]), rowCount: 1 };
  if (text.startsWith('INSERT INTO commit_snapshots')) commits[String(params[0])] = params.slice(1);
  if (text.startsWith('INSERT INTO loc_snapshots')) lines[String(params[0])] = (lines[String(params[0])] ?? 0) + Number(params[3]);
  if (text.startsWith('UPDATE collector_runs')) run = params;
  return { rows: [], rowCount: 0 };
};
const mutable = log as unknown as Record<string, (msg: string, fields?: Record<string, unknown>) => void>;
for (const level of ['info', 'warn', 'error']) {
  mutable[level] = (msg, fields) => {
    logged.push(`${msg} ${JSON.stringify(fields ?? {})}`);
    if (msg === 'git.repo_failed') failed.push({ repo: String(fields?.repo), err: String(fields?.err) });
  };
}

if (process.env.SCAN_READY) fs.writeFileSync(process.env.SCAN_READY, String(process.pid));
const started = Date.now();
await runGitScan();
// UPDATE collector_runs SET finished_at=now(), repos_total=$2, repos_ok=$3, repos_err=$4, error=$5 WHERE id=$1
process.stdout.write(`RESULT ${JSON.stringify({
  ok: Number(run[2]), err: Number(run[3]), error: (run[4] as string | null) ?? null,
  failed, lines, commits, ms: Date.now() - started, log: logged.join('\n'),
})}\n`);
process.exit(0);
