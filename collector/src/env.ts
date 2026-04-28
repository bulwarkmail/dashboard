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
  reposDir: process.env.COLLECTOR_REPOS_DIR || './data/repos',
  runOnce: process.argv.includes('--once'),
};
