import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv(path.resolve(here, '..', '..', '.env'));

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  port: num('VERSION_SERVER_PORT', 3009),
  host: process.env.VERSION_SERVER_HOST || '127.0.0.1',
  // Source repo for releases. Change in .env to point at a fork without rebuilding.
  githubRepo: process.env.VERSION_SERVER_REPO || 'bulwarkmail/webmail',
  // Refresh interval in milliseconds. One hour by default; the public endpoint
  // is allowed to be stale by up to this much.
  refreshIntervalMs: num('VERSION_SERVER_REFRESH_MS', 60 * 60 * 1000),
  // Optional GitHub token to lift the unauthenticated rate limit (60 req/h/IP).
  // Public-repo reads work fine without one.
  githubToken: process.env.VERSION_SERVER_GITHUB_TOKEN || '',
  // Native app repo whose newest APK /android/latest.apk redirects to.
  androidRepo: process.env.VERSION_SERVER_ANDROID_REPO || 'bulwarkmail/native',
  // Polled more often than the webmail releases so a new APK is served soon
  // after it is attached. 10 minutes = 6 req/h, well inside the anonymous limit.
  androidRefreshIntervalMs: num('VERSION_SERVER_ANDROID_REFRESH_MS', 10 * 60 * 1000),
};
