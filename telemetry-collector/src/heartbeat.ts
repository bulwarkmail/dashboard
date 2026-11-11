import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import type { CleanHeartbeat, CleanHeartbeatV2 } from './validate.js';

/** The UTC day before `day` (YYYY-MM-DD). */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether a heartbeat of this instance id may be stored. An id the collector
 * knows (a heartbeat or instance_meta row) always may. Of the ids it has not
 * seen, those of the first `maxNewInstancesPerDay` heartbeats of the UTC day
 * they arrive on may; the rest are answered as stored and dropped, and one
 * warning a day says so. The count lives in new_instance_counts, so a restart
 * doesn't reset it.
 */
async function admit(instanceId: string, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const { rows } = await pool.query<{ count: number }>(
    `WITH known AS (
       SELECT 1 FROM heartbeats WHERE instance_id = $1
       UNION ALL
       SELECT 1 FROM instance_meta WHERE instance_id = $1
       LIMIT 1
     )
     INSERT INTO new_instance_counts (day, count)
     SELECT $2, 1 WHERE NOT EXISTS (SELECT 1 FROM known)
     ON CONFLICT (day) DO UPDATE SET count = new_instance_counts.count + 1
     RETURNING count`,
    [instanceId, day],
  );
  const count = rows[0]?.count;
  if (count === undefined || count <= env.maxNewInstancesPerDay) return true;
  if (count === env.maxNewInstancesPerDay + 1) {
    log.warn('heartbeat.new_instances_capped', { day, max: env.maxNewInstancesPerDay });
  }
  return false;
}

/**
 * Store one validated heartbeat, arriving at `now`. The heartbeat row has the
 * same fields for both schemas (v2's `errors` go to error_counts instead), so
 * every panel and the rollup read v1 and v2 alike. A v2 heartbeat's error
 * counts are for the UTC day before the heartbeat's day; they replace what
 * this instance sent for that day before. Returns false when the heartbeat
 * was dropped (see `admit`).
 */
export async function storeHeartbeat(clean: CleanHeartbeat | CleanHeartbeatV2, now = Date.now()): Promise<boolean> {
  if (!(await admit(clean.instance_id, now))) return false;
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
  if (desktop) return true;
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
  if (clean.schema !== '2') return true;

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
  return true;
}
