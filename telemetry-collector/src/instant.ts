import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import { SEND_TIMEOUT_MS, buildForwardEvent, chargeReporter, envelope, envelopeUrlFor, forwardBudget, refundReporter } from './forward.js';
import { knownForMoreThanADay, recordArrival } from './heartbeat.js';
import type { CleanErrorBatch } from './validate.js';

// Instant error counts (POST /v1/errors): instances with the error-count
// consent on "instant" send the current day's counts about once a minute,
// only the errors that are new or reached a higher count bucket.
//
// They go into error_counts like a heartbeat's, for the day they are for;
// that instance's next heartbeat replaces them with the complete day. The
// first report of a (day, fingerprint, version) from an instance the
// collector first stored more than a day ago goes to Bugsink at once, while
// instant forwards have used less than half of the day's budget. Later
// reports don't: the daily forward sends the summary across instances two
// days later, into the same Bugsink issue, and keeps the other half.

/** Instant forwards to Bugsink per minute, across all instances. */
export const INSTANT_PER_MINUTE = 30;
/** One batch per instance per this long. */
export const INSTANCE_INTERVAL_MS = 30_000;

/** Ids the limiter keeps at most. */
export const LIMITER_MAX_IDS = 10_000;

/**
 * Lets each instance through once per `intervalMs`. In memory, at most
 * `maxIds` ids: past that, the id let through longest ago is dropped. `prune`,
 * on a timer, drops the ids whose interval is over, so no id is kept past it;
 * a request never walks the map.
 */
export class InstanceLimiter {
  // In the order the ids were let through: the oldest first.
  private last = new Map<string, number>();
  constructor(private readonly intervalMs: number, private readonly maxIds = LIMITER_MAX_IDS) {}

  allow(instanceId: string, now = Date.now()): boolean {
    const previous = this.last.get(instanceId);
    if (previous !== undefined && now - previous < this.intervalMs) return false;
    this.last.delete(instanceId);
    this.last.set(instanceId, now);
    if (this.last.size > this.maxIds) {
      const oldest = this.last.keys().next();
      if (!oldest.done) this.last.delete(oldest.value);
    }
    return true;
  }

  /** Drop the ids whose interval is over. Stops at the first one still inside it. */
  prune(now = Date.now()): void {
    for (const [id, at] of this.last) {
      if (now - at < this.intervalMs) break;
      this.last.delete(id);
    }
  }

  get size(): number {
    return this.last.size;
  }
}

let windowStart = 0;
let windowCount = 0;

/** For tests. */
export function resetInstantForTests(): void {
  windowStart = 0;
  windowCount = 0;
}

function takeSlot(now: number): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= INSTANT_PER_MINUTE) return false;
  windowCount++;
  return true;
}

function giveSlotBack(): void {
  if (windowCount > 0) windowCount--;
}

/**
 * Instant forwards that may still go out on the UTC day of `now`: at most
 * half of `maxForwardedGroupsPerDay` a day, so the daily forward keeps the
 * other half.
 */
async function instantShareLeft(now: number): Promise<number> {
  const since = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const { rows } = await pool.query<{ instant: string | number }>(
    'SELECT count(*) AS instant FROM error_instant_forwards WHERE forwarded_at >= $1',
    [since],
  );
  return Math.max(0, Math.floor(env.maxForwardedGroupsPerDay / 2) - Number(rows[0]?.instant ?? 0));
}

/**
 * Store a batch arriving at `now`: each error replaces what this instance
 * sent for it that day.
 */
export async function storeInstantErrors(batch: CleanErrorBatch, now = Date.now()): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const error of batch.errors) {
      await client.query(
        `INSERT INTO error_counts (instance_id, day, fingerprint, version, name, frames, count_bucket, days, message)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         ON CONFLICT (instance_id, day, fingerprint, version) DO UPDATE SET
           name = EXCLUDED.name,
           frames = EXCLUDED.frames,
           count_bucket = EXCLUDED.count_bucket,
           days = EXCLUDED.days,
           message = EXCLUDED.message`,
        [batch.instance_id, batch.day, error.fingerprint, error.version, error.name, JSON.stringify(error.frames), error.count, error.days, error.message],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await recordArrival(batch.instance_id, now);
}

/**
 * Send the errors of `batch` no instance reported yet today to Bugsink, if
 * the collector first stored the instance more than a day ago, while the
 * day's budget of forwarded groups (`forwardBudget`), the instant forwards'
 * half of it (`instantShareLeft`) and the instance's share (`chargeReporter`)
 * last. An instance first stored today or yesterday waits for the daily
 * forward.
 * Each is claimed in error_instant_forwards first, so it goes once across
 * instances and concurrent batches; a failed send gives the claim back.
 * Never throws.
 */
export async function forwardInstant(batch: CleanErrorBatch, now = Date.now()): Promise<{ forwarded: number; failed: number }> {
  const result = { forwarded: 0, failed: 0 };
  if (!env.bugsinkTelemetryDsn) return result;
  const target = envelopeUrlFor(env.bugsinkTelemetryDsn);
  if (!target) return result;
  try {
    if (!(await knownForMoreThanADay(batch.instance_id, now))) return result;
    const budget = Math.min(await forwardBudget(now), await instantShareLeft(now));
    for (const error of batch.errors) {
      if (result.forwarded >= budget) break;
      if (!takeSlot(now)) break;
      const claim = await pool.query(
        `INSERT INTO error_instant_forwards (day, fingerprint, version) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
        [batch.day, error.fingerprint, error.version],
      );
      if (!claim.rowCount) {
        giveSlotBack();
        continue;
      }
      // One instance brings in at most its share of the day's forwards.
      if (!(await chargeReporter([batch.instance_id], now))) {
        await pool.query(
          `DELETE FROM error_instant_forwards WHERE day = $1 AND fingerprint = $2 AND version = $3`,
          [batch.day, error.fingerprint, error.version],
        );
        giveSlotBack();
        break;
      }
      let ok = false;
      try {
        const event = buildForwardEvent({
          day: batch.day,
          fingerprint: error.fingerprint,
          version: error.version,
          name: error.name,
          frames: error.frames,
          message: error.message,
          instances: 1,
          buckets: [error.count],
          max_days: error.days,
        }, { instantAt: now });
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-sentry-envelope' },
          body: envelope(event),
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        ok = res.ok;
        if (!ok) log.warn('instant.rejected', { status: res.status });
      } catch (e) {
        log.warn('instant.failed', { err: e instanceof Error ? e.name : 'unknown' });
      }
      if (!ok) {
        await pool.query(
          `DELETE FROM error_instant_forwards WHERE day = $1 AND fingerprint = $2 AND version = $3`,
          [batch.day, error.fingerprint, error.version],
        );
        await refundReporter(batch.instance_id, now);
        result.failed++;
        // Bugsink is likely down; the rest wait for a later batch or the daily forward.
        break;
      }
      result.forwarded++;
    }
  } catch (e) {
    log.error('instant.aborted', { err: e instanceof Error ? e.message : String(e) });
  }
  if (result.forwarded || result.failed) log.info('instant.done', result);
  return result;
}
