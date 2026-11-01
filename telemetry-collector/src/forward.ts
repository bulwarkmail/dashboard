import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import type { CleanErrorFrame } from './validate.js';

// Forward the error counts of schema 2 heartbeats to Bugsink, so the
// project sees which errors a release causes across instances.
//
// One event per (day, fingerprint, version) once the day is complete: the
// counts of a day arrive with the heartbeats of the next day, so a day is
// forwarded two days later. The event says how many instances reported it
// and their count buckets. It never carries an instance id. Frames point
// into Bulwark's bundles and carry their debug IDs, so Bugsink resolves them
// through the source maps CI uploaded.
//
// Off without BUGSINK_TELEMETRY_DSN. Runs on its own timer: a failure here
// never touches the heartbeat path.

const BUCKET_FLOOR: Record<string, number> = { '1': 1, '2-5': 2, '6-10': 6, '11-50': 11, '51-200': 51, '201+': 201 };
export const SEND_TIMEOUT_MS = 10_000;
const BATCH = 500;

export interface ErrorGroup {
  day: string;
  fingerprint: string;
  version: string;
  name: string;
  frames: CleanErrorFrame[];
  message: string | null;
  instances: number;
  buckets: string[];
  max_days: number;
}

interface Dsn { url: string }

/** `https://<key>@host[/prefix]/<project>` -> the envelope URL, or null. */
export function envelopeUrlFor(dsn: string): Dsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!url.username || !project || !/^\d+$/.test(project)) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  return { url: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/?sentry_key=${url.username}&sentry_version=7` };
}

/**
 * The event for one group. Pure, for tests. `instantAt`: an instant
 * forward (the first report of the day), stamped with when it came in
 * instead of the start of the day.
 */
export function buildForwardEvent(group: ErrorGroup, opts: { instantAt?: number } = {}): Record<string, unknown> {
  const day = typeof group.day === 'string' ? group.day.slice(0, 10) : new Date(group.day).toISOString().slice(0, 10);
  const browser = group.frames.some((frame) => frame.path.startsWith('/_next/static/'));
  const histogram: Record<string, number> = {};
  for (const bucket of group.buckets) histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  const atLeast = group.buckets.reduce((sum, bucket) => sum + (BUCKET_FLOOR[bucket] ?? 0), 0);
  const frames = [...group.frames].reverse().map((frame) => ({
    abs_path: frame.path,
    filename: frame.path,
    ...(frame.line !== null ? { lineno: frame.line } : {}),
    ...(frame.col !== null ? { colno: frame.col } : {}),
    in_app: true,
  }));
  const images = [...new Map(group.frames.filter((f) => f.debug_id).map((f) => [f.path, f.debug_id])).entries()]
    .map(([path, id]) => ({ type: 'sourcemap', code_file: path, debug_id: id }));
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: (opts.instantAt ?? Date.parse(`${day}T00:00:00Z`)) / 1000,
    platform: browser ? 'javascript' : 'node',
    level: 'error',
    release: group.version,
    environment: 'telemetry',
    fingerprint: ['bulwark-telemetry', group.fingerprint, group.version],
    exception: {
      values: [{
        type: group.name,
        value: group.message ?? group.name,
        mechanism: { type: 'telemetry', handled: true },
        ...(frames.length ? { stacktrace: { frames } } : {}),
      }],
    },
    ...(images.length ? { debug_meta: { images } } : {}),
    tags: {
      source: 'telemetry',
      mode: opts.instantAt === undefined ? 'daily' : 'instant',
      runtime: browser ? 'browser' : 'server',
      instances: String(group.instances),
      day,
    },
    extra: { instances: group.instances, count_buckets: histogram, count_at_least: atLeast, most_days_in_a_week: group.max_days },
    sdk: { name: 'bulwark.telemetry-collector', version: '1' },
  };
}

export function envelope(event: Record<string, unknown>): string {
  return `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n`
    + `${JSON.stringify({ type: 'event', content_type: 'application/json' })}\n${JSON.stringify(event)}\n`;
}

/** The last day whose counts are complete: two days before `now`. */
export function lastCompleteDay(now = Date.now()): string {
  return new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
}

/** Forward every complete group not forwarded yet. Never throws. */
export async function runForward(now = Date.now()): Promise<{ forwarded: number; failed: number }> {
  const result = { forwarded: 0, failed: 0 };
  if (!env.bugsinkTelemetryDsn) return result;
  const target = envelopeUrlFor(env.bugsinkTelemetryDsn);
  if (!target) {
    log.warn('forward.bad_dsn');
    return result;
  }
  try {
    const groups = await pool.query<ErrorGroup>(
      `SELECT to_char(ec.day, 'YYYY-MM-DD') AS day, ec.fingerprint, ec.version,
              min(ec.name) AS name,
              (array_agg(ec.frames ORDER BY jsonb_array_length(ec.frames) DESC))[1] AS frames,
              min(ec.message) AS message,
              count(DISTINCT ec.instance_id)::int AS instances,
              array_agg(ec.count_bucket) AS buckets,
              max(ec.days)::int AS max_days
         FROM error_counts ec
        WHERE ec.day <= $1
          AND NOT EXISTS (SELECT 1 FROM error_forwards f
                           WHERE f.day = ec.day AND f.fingerprint = ec.fingerprint AND f.version = ec.version)
        GROUP BY ec.day, ec.fingerprint, ec.version
        ORDER BY ec.day, ec.fingerprint, ec.version
        LIMIT ${BATCH}`,
      [lastCompleteDay(now)],
    );
    for (const group of groups.rows) {
      let ok = false;
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-sentry-envelope' },
          body: envelope(buildForwardEvent(group)),
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        ok = res.ok;
        if (!ok) log.warn('forward.rejected', { status: res.status });
      } catch (e) {
        log.warn('forward.failed', { err: e instanceof Error ? e.name : 'unknown' });
      }
      if (!ok) {
        // Try again on the next run; stop this one, the tracker is likely down.
        result.failed++;
        break;
      }
      await pool.query(
        `INSERT INTO error_forwards (day, fingerprint, version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [group.day, group.fingerprint, group.version],
      );
      result.forwarded++;
    }
  } catch (e) {
    log.error('forward.aborted', { err: e instanceof Error ? e.message : String(e) });
  }
  if (result.forwarded || result.failed) log.info('forward.done', result);
  return result;
}
