import { pool } from './db.js';
import type { CleanHeartbeat, CleanHeartbeatV2 } from './validate.js';

/** The UTC day before `day` (YYYY-MM-DD). */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Store one validated heartbeat. The heartbeat row has the same fields for
 * both schemas (v2's `errors` go to error_counts instead), so every panel
 * and the rollup read v1 and v2 alike. A v2 heartbeat's error counts are for the last
 * complete UTC day before it was sent; they replace what this instance sent
 * for that day before.
 */
export async function storeHeartbeat(clean: CleanHeartbeat | CleanHeartbeatV2): Promise<void> {
  const day = clean.ts.slice(0, 10);
  const { errors, ...stored } = clean as CleanHeartbeatV2;
  // A desktop app is one person: the time it starts each day says when they work.
  const desktop = clean.platform === 'desktop';
  const receivedAt = desktop ? `date_trunc('day', now())` : 'now()';
  await pool.query(
    `INSERT INTO heartbeats (instance_id, day, payload, received_at)
     VALUES ($1, $2, $3::jsonb, ${receivedAt})
     ON CONFLICT (instance_id, day) DO UPDATE SET
       payload = EXCLUDED.payload,
       received_at = ${receivedAt}`,
    [clean.instance_id, day, JSON.stringify(stored)],
  );
  // "Instances ever seen" counts servers.
  if (desktop) return;
  // Maintain instance_meta inline so panels keyed off first/last/days_seen
  // are correct in real time without waiting for the daily rollup.
  await pool.query(
    `INSERT INTO instance_meta (instance_id, first_seen, last_seen, days_seen)
     VALUES ($1, $2, $2, 1)
     ON CONFLICT (instance_id) DO UPDATE SET
       last_seen = GREATEST(instance_meta.last_seen, EXCLUDED.last_seen),
       first_seen = LEAST(instance_meta.first_seen, EXCLUDED.first_seen),
       days_seen = (
         SELECT count(DISTINCT day)::int
         FROM heartbeats
         WHERE heartbeats.instance_id = EXCLUDED.instance_id
       )`,
    [clean.instance_id, day],
  );
  if (clean.schema !== '2') return;

  const errorDay = dayBefore(day);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM error_counts WHERE instance_id = $1 AND day = $2', [clean.instance_id, errorDay]);
    for (const error of errors) {
      await client.query(
        `INSERT INTO error_counts (instance_id, day, fingerprint, version, name, frames, count_bucket, days, message)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [clean.instance_id, errorDay, error.fingerprint, error.version, error.name, JSON.stringify(error.frames), error.count, error.days, error.message],
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
