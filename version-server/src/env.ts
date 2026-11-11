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

/** The longest delay a Node timer holds; setInterval runs anything longer after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A refresh interval from the environment: a positive number of milliseconds a timer holds. Any
 * other value that is set (0, a negative number, a blank value, text, too long) gives `fallback`,
 * with one log line naming the setting and the value used.
 */
function interval(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= MAX_TIMER_MS) return n;
  // The same line format as log.ts, which env.ts does not import.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'setting_ignored', setting: name, given: raw.slice(0, 40), used: fallback })}\n`);
  return fallback;
}

export const env = {
  port: num('VERSION_SERVER_PORT', 3009),
  host: process.env.VERSION_SERVER_HOST || '127.0.0.1',
  // Source repo for releases. Change in .env to point at a fork without rebuilding.
  githubRepo: process.env.VERSION_SERVER_REPO || 'bulwarkmail/webmail',
  // Refresh interval in milliseconds. One hour by default; the public endpoint
  // is allowed to be stale by up to this much.
  refreshIntervalMs: interval('VERSION_SERVER_REFRESH_MS', 60 * 60 * 1000),
  // Optional GitHub token to lift the unauthenticated rate limit (60 req/h/IP).
  // Public-repo reads work fine without one.
  githubToken: process.env.VERSION_SERVER_GITHUB_TOKEN || '',
  // Native app repo whose newest APK /android/latest.apk redirects to.
  androidRepo: process.env.VERSION_SERVER_ANDROID_REPO || 'bulwarkmail/native',
  // Polled more often than the webmail releases so a new APK is served soon
  // after it is attached. 10 minutes = 6 req/h, well inside the anonymous limit.
  androidRefreshIntervalMs: interval('VERSION_SERVER_ANDROID_REFRESH_MS', 10 * 60 * 1000),
};
