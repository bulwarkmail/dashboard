import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import { promoteInstance } from './heartbeat.js';

// Deferred heartbeats (pending_heartbeats): new instance ids past the day's
// limit wait here instead of being dropped, one row per id and heartbeat day,
// counted once, without error counts, for at most PENDING_RETENTION_DAYS
// (rollup.ts). An honest new installation is late on a busy day. But once
// TELEMETRY_MAX_DEFERRED_PER_DAY (5,000) new ids wait from one day, on top of
// the TELEMETRY_MAX_NEW_INSTANCES_PER_DAY stored at once, further new
// installations of that day are not counted; they get in on a later day with
// room. Each UTC day up to TELEMETRY_MAX_NEW_INSTANCES_PER_DAY
// waiting ids are counted, on top of the day's own new ids:
//   - first ids that came back on another day (an installation sends a heartbeat
//     every day; a made-up id has to be sent again on purpose),
//   - then ids waiting for at least two days,
// each group oldest first. So the "instances ever seen" total can grow by at
// most twice the limit a day, and a waiting id moves up as the older ones are
// counted.

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Count waiting ids into today's budget. Never throws. Returns how many were counted. */
export async function promotePending(now = Date.now()): Promise<number> {
  const today = utcDay(now);
  let promoted = 0;
  try {
    const used = await pool.query<{ promoted: number }>('SELECT promoted FROM new_instance_counts WHERE day = $1', [today]);
    const left = env.maxNewInstancesPerDay - Number(used.rows[0]?.promoted ?? 0);
    if (left <= 0) return 0;
    const waiting = await pool.query<{ instance_id: string }>(
      `SELECT instance_id FROM pending_heartbeats
        GROUP BY instance_id
       HAVING count(*) >= 2 OR min(day) <= $1
        ORDER BY count(*) DESC, min(first_received_at), instance_id
        LIMIT $2`,
      [utcDay(now - 2 * DAY_MS), left],
    );
    for (const { instance_id } of waiting.rows) {
      if ((await promoteInstance(instance_id, now)) === 0) continue;
      await pool.query(
        `INSERT INTO new_instance_counts (day, count, promoted) VALUES ($1, 0, 1)
         ON CONFLICT (day) DO UPDATE SET promoted = new_instance_counts.promoted + 1`,
        [today],
      );
      promoted++;
    }
  } catch (e) {
    log.error('pending.aborted', { err: e instanceof Error ? e.message : String(e) });
  }
  if (promoted) log.info('pending.promoted', { promoted });
  return promoted;
}
