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
  port: num('TELEMETRY_PORT', 3008),
  host: process.env.TELEMETRY_HOST || '127.0.0.1',
  pgHost: process.env.PG_HOST || '127.0.0.1',
  pgPort: num('PG_PORT', 5432),
  pgUser: process.env.TELEMETRY_PG_USER || 'telemetry',
  pgPassword: required('POSTGRES_TELEMETRY_PASSWORD'),
  pgDatabase: process.env.TELEMETRY_PG_DB || 'telemetry',
  retentionDays: num('TELEMETRY_RETENTION_DAYS', 90),
  // Instance ids the collector has not seen before whose heartbeats or error
  // batches are stored per UTC day; past that a new id's heartbeat is deferred
  // (pending_heartbeats) and its error batch refused with 429. As many
  // deferred ids are counted per day.
  maxNewInstancesPerDay: num('TELEMETRY_MAX_NEW_INSTANCES_PER_DAY', 500),
  // Heartbeats from unknown ids deferred per UTC day past that; beyond this
  // they are dropped.
  maxDeferredPerDay: num('TELEMETRY_MAX_DEFERRED_PER_DAY', 5000),
  // Where complete days of error counts are forwarded (a Sentry-protocol
  // DSN). Empty: nothing is forwarded.
  bugsinkTelemetryDsn: (process.env.BUGSINK_TELEMETRY_DSN ?? '').trim(),
  // Error groups sent to Bugsink per UTC day, daily and instant forwards
  // together; the rest wait for the next day.
  maxForwardedGroupsPerDay: num('TELEMETRY_MAX_FORWARDED_GROUPS_PER_DAY', 100),
  // Of those, how many one reporting instance can bring in per UTC day.
  maxForwardsPerInstancePerDay: num('TELEMETRY_MAX_FORWARDS_PER_INSTANCE_PER_DAY', 10),
};
