import { pool } from './db.js';
import { env } from './env.js';
import { log } from './log.js';

// Daily job:
// 1. Compute aggregate counts for each day in the heartbeats table that
//    doesn't already have a row in daily_rollups.
// 2. Update instance_meta first/last/days_seen.
// 3. Delete heartbeats older than retentionDays, and instance_meta rows of
//    instances last seen before then. Past the window only daily_rollups
//    remain (no per-instance grain).

export async function runRollup(): Promise<void> {
  const runId = (await pool.query(
    `INSERT INTO collector_runs (job) VALUES ('rollup') RETURNING id`,
  )).rows[0].id as number;

  let processed = 0;
  let firstError: string | null = null;
  try {
    const days = await pool.query<{ day: string }>(
      `SELECT DISTINCT day FROM heartbeats
       WHERE day NOT IN (SELECT day FROM daily_rollups)
       ORDER BY day`,
    );
    for (const row of days.rows) {
      try {
        await rollupDay(row.day);
        processed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstError) firstError = `${row.day}: ${msg}`;
        log.warn('rollup.day_failed', { day: row.day, err: msg });
      }
    }

    await pool.query(`
      INSERT INTO instance_meta (instance_id, first_seen, last_seen, days_seen)
      SELECT instance_id, MIN(day), MAX(day), COUNT(DISTINCT day)
      FROM heartbeats
      GROUP BY instance_id
      ON CONFLICT (instance_id) DO UPDATE SET
        first_seen = LEAST(instance_meta.first_seen, EXCLUDED.first_seen),
        last_seen  = GREATEST(instance_meta.last_seen, EXCLUDED.last_seen),
        days_seen  = GREATEST(instance_meta.days_seen, EXCLUDED.days_seen)
    `);

    const cutoff = new Date(Date.now() - env.retentionDays * 86_400_000)
      .toISOString().slice(0, 10);
    const del = await pool.query(`DELETE FROM heartbeats WHERE day < $1`, [cutoff]);
    log.info('rollup.deleted_raw', { cutoff, rows: del.rowCount });
    // Error counts (schema 2) keep the same window.
    const delErrors = await pool.query(`DELETE FROM error_counts WHERE day < $1`, [cutoff]);
    await pool.query(`DELETE FROM error_forwards WHERE day < $1`, [cutoff]);
    log.info('rollup.deleted_error_counts', { cutoff, rows: delErrors.rowCount });
    // Instances not seen within the retention window lose their row too, so
    // no instance_id is kept past it. The same statement adds how many went to
    // expired_instances, so the "instances ever seen" total doesn't drop.
    const delMeta = await pool.query<{ deleted: number }>(
      `WITH gone AS (DELETE FROM instance_meta WHERE last_seen < $1 RETURNING 1),
            n AS (SELECT count(*)::int AS deleted FROM gone),
            counted AS (
              INSERT INTO expired_instances (day, count)
              SELECT current_date, deleted FROM n WHERE deleted > 0
              ON CONFLICT (day) DO UPDATE SET count = expired_instances.count + EXCLUDED.count
            )
       SELECT deleted FROM n`,
      [cutoff],
    );
    log.info('rollup.deleted_instance_meta', { cutoff, rows: delMeta.rows[0]?.deleted ?? 0 });
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e);
    log.error('rollup.aborted', { err: firstError });
  } finally {
    await pool.query(
      `UPDATE collector_runs SET finished_at = now(), rows_processed = $2, error = $3 WHERE id = $1`,
      [runId, processed, firstError],
    );
    log.info('rollup.done', { processed });
  }
}

async function rollupDay(day: string): Promise<void> {
  const r = await pool.query<{
    active_instances: number;
    by_platform: Record<string, number>;
    by_version: Record<string, number>;
    by_os_family: Record<string, number>;
    feature_adoption: Record<string, number>;
    account_buckets: Record<string, number>;
  }>(
    `WITH src AS (
       SELECT payload FROM heartbeats WHERE day = $1
     ),
     base AS (
       SELECT
         (payload->>'platform')           AS platform,
         (payload->>'version')            AS version,
         (payload->>'os_family')          AS os_family,
         (payload->'features')            AS features,
         (payload->'counts'->>'accounts') AS accounts_bucket
       FROM src
     )
     SELECT
       (SELECT count(*) FROM src)::int AS active_instances,
       (SELECT jsonb_object_agg(platform, c) FROM (SELECT platform, count(*) AS c FROM base GROUP BY platform) x)         AS by_platform,
       (SELECT jsonb_object_agg(version,  c) FROM (SELECT version,  count(*) AS c FROM base GROUP BY version)  x)         AS by_version,
       (SELECT jsonb_object_agg(os_family,c) FROM (SELECT os_family,count(*) AS c FROM base GROUP BY os_family) x)        AS by_os_family,
       (SELECT jsonb_object_agg(k, c)
          FROM (
            SELECT k, count(*) FILTER (WHERE (features ->> k)::boolean) AS c
            FROM base, jsonb_object_keys(features) k
            GROUP BY k
          ) x)                                                                                                            AS feature_adoption,
       (SELECT jsonb_object_agg(accounts_bucket, c) FROM (SELECT accounts_bucket, count(*) AS c FROM base GROUP BY accounts_bucket) x) AS account_buckets`,
    [day],
  );
  const row = r.rows[0];
  await pool.query(
    `INSERT INTO daily_rollups (day, active_instances, by_platform, by_version, by_os_family, feature_adoption, account_buckets)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (day) DO UPDATE SET
       active_instances = EXCLUDED.active_instances,
       by_platform      = EXCLUDED.by_platform,
       by_version       = EXCLUDED.by_version,
       by_os_family     = EXCLUDED.by_os_family,
       feature_adoption = EXCLUDED.feature_adoption,
       account_buckets  = EXCLUDED.account_buckets,
       computed_at      = now()`,
    [
      day,
      row.active_instances ?? 0,
      row.by_platform ?? {},
      row.by_version ?? {},
      row.by_os_family ?? {},
      row.feature_adoption ?? {},
      row.account_buckets ?? {},
    ],
  );
}
