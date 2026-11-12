import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import type { CleanHeartbeat, CleanHeartbeatV2 } from './validate.js';

/** The UTC day before `day` (YYYY-MM-DD). */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

// The ids the collector knows: those with a heartbeat, an instance_meta row or
// error counts.
const KNOWN_ID = `SELECT 1 FROM heartbeats WHERE instance_id = $1
       UNION ALL
       SELECT 1 FROM instance_meta WHERE instance_id = $1
       UNION ALL
       SELECT 1 FROM error_counts WHERE instance_id = $1
       LIMIT 1`;

/**
 * Note that the collector stored something of this instance id at `now`: the
 * UTC day of the first time stays in instance_arrivals.
 */
export async function recordArrival(instanceId: string, now: number): Promise<void> {
  await pool.query(
    'INSERT INTO instance_arrivals (instance_id, first_day) VALUES ($1, $2) ON CONFLICT (instance_id) DO NOTHING',
    [instanceId, new Date(now).toISOString().slice(0, 10)],
  );
}

/**
 * Whether the collector first stored this instance id more than a day before
 * `now`, by its own clock: on the UTC day before yesterday or earlier.
 */
export async function knownForMoreThanADay(instanceId: string, now: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM instance_arrivals WHERE instance_id = $1 AND first_day < $2::date - 1',
    [instanceId, new Date(now).toISOString().slice(0, 10)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Whether an error batch of this instance id, arriving at `now`, may be
 * stored. A known id may. An id the collector hasn't seen takes one of the
 * day's places for new ids (new_instance_counts, shared with heartbeats) and
 * is known from then on; its deferred heartbeats are stored with it. With no
 * place left it may not, and the count stays as it is: a sender that tries
 * again later takes nothing from the waiting heartbeats' places.
 */
export async function admitErrorSender(instanceId: string, now = Date.now()): Promise<boolean> {
  const { rows } = await pool.query<{ known: boolean; count: number | null }>(
    `WITH known AS (
       ${KNOWN_ID}
     ), placed AS (
       INSERT INTO new_instance_counts (day, count)
       SELECT $2, 1 WHERE NOT EXISTS (SELECT 1 FROM known)
       ON CONFLICT (day) DO UPDATE SET count = new_instance_counts.count + 1
        WHERE new_instance_counts.count < $3
       RETURNING count
     )
     SELECT EXISTS (SELECT 1 FROM known) AS known, (SELECT count FROM placed) AS count`,
    [instanceId, new Date(now).toISOString().slice(0, 10), env.maxNewInstancesPerDay],
  );
  const row = rows[0];
  if (!row || row.known) return true;
  if (row.count === null || row.count > env.maxNewInstancesPerDay) return false;
  await promoteInstance(instanceId, now);
  return true;
}

type Admission = 'known' | 'new' | 'waiting' | 'defer' | 'drop';

/**
 * What happens to a heartbeat of this instance id for `heartbeatDay`. An id
 * the collector knows (a heartbeat, instance_meta row or error counts) is
 * always stored. An id already waiting for that day (pending_heartbeats) is
 * neither counted nor stored again. Of the other ids it has not seen, those
 * of the first `maxNewInstancesPerDay` heartbeats and error batches of the UTC
 * day they arrive on are stored, the next `maxDeferredPerDay` heartbeats are
 * deferred (pending_heartbeats, counted later by pending.ts), the rest
 * dropped; each step logs one warning a day. The count lives in
 * new_instance_counts, so a restart doesn't reset it.
 */
async function admit(instanceId: string, heartbeatDay: string, now: number): Promise<Admission> {
  const day = new Date(now).toISOString().slice(0, 10);
  const { rows } = await pool.query<{ known: boolean; count: number | null }>(
    `WITH known AS (
       ${KNOWN_ID}
     ), waiting AS (
       SELECT 1 FROM pending_heartbeats WHERE instance_id = $1 AND day = $3
     ), counted AS (
       INSERT INTO new_instance_counts (day, count)
       SELECT $2, 1 WHERE NOT EXISTS (SELECT 1 FROM known) AND NOT EXISTS (SELECT 1 FROM waiting)
       ON CONFLICT (day) DO UPDATE SET count = new_instance_counts.count + 1
       RETURNING count
     )
     SELECT EXISTS (SELECT 1 FROM known) AS known, (SELECT count FROM counted) AS count`,
    [instanceId, day, heartbeatDay],
  );
  const row = rows[0];
  if (!row || row.known) return 'known';
  const count = row.count;
  if (count === null) return 'waiting';
  const max = env.maxNewInstancesPerDay;
  if (count <= max) return 'new';
  if (count === max + 1) log.warn('heartbeat.new_instances_deferred', { day, max });
  if (count <= max + env.maxDeferredPerDay) return 'defer';
  if (count === max + env.maxDeferredPerDay + 1) log.warn('heartbeat.new_instances_dropped', { day, max: env.maxDeferredPerDay });
  return 'drop';
}

/**
 * Store one validated heartbeat, arriving at `now`: 'stored', 'deferred' (a
 * new id past the day's limit, or one already waiting for that day; pending.ts
 * counts it later) or 'dropped' (past the deferred limit too). A new id that
 * had deferred heartbeats gets them stored with this one.
 */
export async function storeHeartbeat(clean: CleanHeartbeat | CleanHeartbeatV2, now = Date.now()): Promise<'stored' | 'deferred' | 'dropped'> {
  const day = clean.ts.slice(0, 10);
  const admission = await admit(clean.instance_id, day, now);
  if (admission === 'drop') return 'dropped';
  if (admission === 'waiting') return 'deferred';
  if (admission === 'defer') {
    // Without its error counts: a waiting row stays a few hundred bytes.
    const { errors: _errors, ...waiting } = clean as CleanHeartbeatV2;
    await pool.query(
      `INSERT INTO pending_heartbeats (instance_id, day, heartbeat) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (instance_id, day) DO NOTHING`,
      [clean.instance_id, day, JSON.stringify(waiting)],
    );
    return 'deferred';
  }
  await writeHeartbeat(clean, now);
  if (admission === 'new') await promoteInstance(clean.instance_id, now);
  return 'stored';
}

/** A deferred heartbeat as pending_heartbeats holds it: without its error counts. */
type WaitingHeartbeat = Omit<CleanHeartbeatV2, 'errors'> & { errors?: CleanHeartbeatV2['errors'] };

/**
 * Store an instance's deferred heartbeats under their own days, oldest first,
 * and remove them from pending_heartbeats, at `now`. Returns how many there
 * were.
 */
export async function promoteInstance(instanceId: string, now = Date.now()): Promise<number> {
  const { rows } = await pool.query<{ day: string; heartbeat: CleanHeartbeat | WaitingHeartbeat }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, heartbeat FROM pending_heartbeats
      WHERE instance_id = $1 ORDER BY day`,
    [instanceId],
  );
  for (const row of rows) {
    await writeHeartbeat(row.heartbeat, now);
    await pool.query('DELETE FROM pending_heartbeats WHERE instance_id = $1 AND day = $2', [instanceId, row.day]);
  }
  return rows.length;
}

/**
 * Write one heartbeat. The heartbeat row has the same fields for both schemas
 * (v2's `errors` go to error_counts instead), so every panel and the rollup
 * read v1 and v2 alike. A v2 heartbeat's error counts are for the UTC day
 * before the heartbeat's day; they replace what this instance sent for that
 * day before. A deferred v2 heartbeat comes without them and touches no
 * error counts. The first heartbeat stored for an id records the UTC day of
 * `now` in instance_arrivals.
 */
async function writeHeartbeat(clean: CleanHeartbeat | CleanHeartbeatV2 | WaitingHeartbeat, now: number): Promise<void> {
  const day = clean.ts.slice(0, 10);
  const { errors, ...stored } = clean as WaitingHeartbeat;
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
  await recordArrival(clean.instance_id, now);
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
  if (clean.schema !== '2' || !errors) return;

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
