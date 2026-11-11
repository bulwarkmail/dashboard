import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.ts needs a password to build its pool; the pool never connects here
// because pool.query is replaced below.
process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';
process.env.TELEMETRY_RETENTION_DAYS = '90';

const { pool } = await import('./db.js');
const { runRollup } = await import('./rollup.js');

test('the rollup deletes instance_meta rows not seen within the retention window', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 1 }], rowCount: 0 };
  });

  await runRollup();

  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const metaDelete = calls.find((c) => c.sql.includes('DELETE FROM instance_meta'));
  assert.ok(metaDelete, 'no DELETE FROM instance_meta was issued');
  assert.match(metaDelete.sql, /DELETE FROM instance_meta WHERE last_seen < \$1/);
  assert.deepEqual(metaDelete.params, [cutoff]);

  // It runs after instance_meta has been refreshed from the heartbeats,
  // so an instance seen inside the window keeps its row.
  const upsert = calls.findIndex((c) => c.sql.startsWith('INSERT INTO instance_meta'));
  assert.ok(upsert >= 0 && upsert < calls.indexOf(metaDelete));
});

test('the rollup counts the instance_meta rows it deletes', async (t) => {
  const calls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: [{ id: 1 }], rowCount: 0 };
  });

  await runRollup();

  // Deleting and counting happen in one statement, so a crash between
  // them can't lose instances from the "ever seen" total.
  const stmt = calls.find((c) => c.includes('DELETE FROM instance_meta'));
  assert.ok(stmt, 'no DELETE FROM instance_meta was issued');
  assert.match(stmt, /INSERT INTO expired_instances \(day, count\)/);
  assert.match(stmt, /count = expired_instances\.count \+ EXCLUDED\.count/);
});

test('the rollup deletes error counts and forward marks past the retention window', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 1 }], rowCount: 0 };
  });

  await runRollup();

  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  for (const table of ['error_counts', 'error_forwards']) {
    const del = calls.find((c) => c.sql === `DELETE FROM ${table} WHERE day < $1`);
    assert.ok(del, `no delete from ${table}`);
    assert.deepEqual(del.params, [cutoff]);
  }
});

test('the daily rollup leaves desktop out of everything but the platform mix', async (t) => {
  const calls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: [{ id: 1, day: '2026-11-03' }], rowCount: 0 };
  });
  await runRollup();
  const stats = calls.find((c) => c.includes('AS by_platform'));
  assert.ok(stats, 'no rollup query');
  assert.match(stats, /FROM server_base\)::int AS active_instances/);
  for (const field of ['by_version', 'by_os_family', 'account_buckets']) {
    assert.match(stats, new RegExp(`FROM server_base GROUP BY [a-z_]+\\) x\\) AS ${field}`), field);
  }
  assert.match(stats, /FROM server_base, jsonb_object_keys\(features\) k/);
  // The platform mix is where desktop shows.
  assert.match(stats, /FROM base GROUP BY platform\) x\) AS by_platform/);
  assert.match(stats, /server_base AS \(SELECT \* FROM base WHERE NOT desktop\)/);
});

test('the rollup picks finished days only, none in the future, and the last two finished days again', async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 1 }], rowCount: 0 };
  });
  await runRollup(Date.parse('2026-11-10T08:00:00Z'));
  const select = calls.find((c) => c.sql.startsWith('SELECT DISTINCT'));
  assert.ok(select, 'no day selection');
  // Before today (so never today or a day after it), and either without a row yet or one of
  // the two days before today. rollup-late-heartbeats.test.ts runs this against Postgres.
  assert.match(select.sql, /WHERE day < \$1 AND \(day >= \$2 OR day NOT IN \(SELECT day FROM daily_rollups\)\)/);
  assert.deepEqual(select.params, ['2026-11-10', '2026-11-08']);
});

test('the rollup doesn\'t add desktop to the instances ever seen', async (t) => {
  const calls: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: [{ id: 1 }], rowCount: 0 };
  });
  await runRollup();
  const upsert = calls.find((c) => c.startsWith('INSERT INTO instance_meta'));
  assert.ok(upsert, 'no upsert');
  assert.match(upsert, /NOT LIKE 'desktop\.%'/);
});
