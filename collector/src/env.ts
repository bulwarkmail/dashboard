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
  fastIntervalMs: num('COLLECTOR_INTERVAL_FAST_MS', 15 * 60 * 1000),
  slowIntervalMs: num('COLLECTOR_INTERVAL_SLOW_MS', 24 * 60 * 60 * 1000),
  reposDir: process.env.COLLECTOR_REPOS_DIR || '/opt/bulwark-dashboard/data/repos',
  // Limits of one repository's git scan (see git.ts).
  scanDeadlineMs: num('COLLECTOR_SCAN_DEADLINE_MS', 30 * 60 * 1000),
  unpackMaxBytes: num('COLLECTOR_UNPACK_MAX_BYTES', 1024 * 1024 * 1024),
  unpackMaxEntries: num('COLLECTOR_UNPACK_MAX_ENTRIES', 200_000),
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
