import fs from 'node:fs';
import path from 'node:path';

function loadDotenv(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/i);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    let value = raw;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
loadDotenv(path.resolve(here, '..', '..', '.env'));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The longest delay a Node timer holds; setTimeout and setInterval run anything longer after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The largest file size a tar header states; the unpack step counts entries from those headers. */
const MAX_UNPACK_BYTES = 8 * 1024 ** 3;

// The same line format as log.ts; env.ts is loaded first and imports nothing of the collector.
function warn(msg: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields })}\n`);
}

/**
 * A limit or interval from the environment: a positive number up to `max`. Any other value that is
 * set (0, a negative number, a blank value, text, more than the timer or the counter holds) gives
 * `fallback`, with one log line naming the setting and the value used. No value switches a limit off.
 */
function limit(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= max) return n;
  warn('collector.setting_ignored', { setting: name, given: raw.slice(0, 40), used: fallback });
  return fallback;
}

// "repo/package,repo/package" — ghcr.io packages whose public page is scraped for pull totals.
function ghcrPackages(raw: string): Array<{ repo: string; pkg: string }> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [repo, pkg] = s.split('/');
      return { repo, pkg: pkg ?? repo };
    });
}

export const env = {
  githubToken: required('GITHUB_TOKEN'),
  githubOrg: process.env.GITHUB_ORG || 'bulwarkmail',
  pgHost: process.env.PG_HOST || '127.0.0.1',
  pgPort: num('PG_PORT', 5432),
  pgUser: process.env.PG_USER || 'dashboard',
  pgPassword: required('POSTGRES_DASHBOARD_PASSWORD'),
  pgDatabase: process.env.PG_DATABASE || 'dashboard',
  fastIntervalMs: limit('COLLECTOR_INTERVAL_FAST_MS', 15 * 60 * 1000, MAX_TIMER_MS),
  slowIntervalMs: limit('COLLECTOR_INTERVAL_SLOW_MS', 24 * 60 * 60 * 1000, MAX_TIMER_MS),
  reposDir: process.env.COLLECTOR_REPOS_DIR || '/opt/bulwark-dashboard/data/repos',
  // Limits of one repository's git scan (see git.ts).
  scanDeadlineMs: limit('COLLECTOR_SCAN_DEADLINE_MS', 30 * 60 * 1000, MAX_TIMER_MS),
  unpackMaxBytes: limit('COLLECTOR_UNPACK_MAX_BYTES', 1024 * 1024 * 1024, MAX_UNPACK_BYTES),
  unpackMaxEntries: limit('COLLECTOR_UNPACK_MAX_ENTRIES', 200_000, Number.MAX_SAFE_INTEGER),
  runOnce: process.argv.includes('--once'),
  ghcrPackages: ghcrPackages(
    process.env.GHCR_PACKAGES
      || 'webmail/webmail,webmail/webmail-lite,webmail/webmail-beta,webmail/webmail-lite-beta,legacy-proxy/legacy-proxy',
  ),
  // App Store Connect (TestFlight install metrics). All three must be set to enable it.
  ascKeyFile: process.env.ASC_KEY_FILE || '',
  ascKeyId: process.env.ASC_KEY_ID || '',
  ascIssuerId: process.env.ASC_ISSUER_ID || '',
  ascBundleId: process.env.ASC_BUNDLE_ID || 'org.bulwarkmail.mobile',
};
