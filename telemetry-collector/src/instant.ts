import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import { SEND_TIMEOUT_MS, buildForwardEvent, envelope, envelopeUrlFor } from './forward.js';
import type { CleanErrorBatch } from './validate.js';

// Instant error counts (POST /v1/errors): instances with the error-count
// consent on "instant" send the current day's counts about once a minute,
// only the errors that are new or reached a higher count bucket.
//
// They go into error_counts like a heartbeat's, for the day they are for;
// that instance's next heartbeat replaces them with the complete day. The
// first report of a (day, fingerprint, version) from any instance goes to
// Bugsink at once. Later reports don't: the daily forward sends the
// summary across instances two days later, into the same Bugsink issue.

/** Instant forwards to Bugsink per minute, across all instances. */
export const INSTANT_PER_MINUTE = 30;
/** One batch per instance per this long. */
export const INSTANCE_INTERVAL_MS = 30_000;

/** Lets each instance through once per `intervalMs`. In memory; no ids kept past that. */
export class InstanceLimiter {
  private last = new Map<string, number>();
  constructor(private readonly intervalMs: number) {}

  allow(instanceId: string, now = Date.now()): boolean {
    const previous = this.last.get(instanceId);
    if (previous !== undefined && now - previous < this.intervalMs) return false;
    if (this.last.size > 10_000) {
      for (const [id, at] of this.last) if (now - at >= this.intervalMs) this.last.delete(id);
    }
    this.last.set(instanceId, now);
    return true;
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

/** Store a batch: each error replaces what this instance sent for it that day. */
export async function storeInstantErrors(batch: CleanErrorBatch): Promise<void> {
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
}

/**
 * Send the errors of `batch` no instance reported yet today to Bugsink.
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
    for (const error of batch.errors) {
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
