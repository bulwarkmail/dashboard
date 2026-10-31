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
