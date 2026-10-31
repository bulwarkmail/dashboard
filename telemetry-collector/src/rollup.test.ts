import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// db.ts needs a password to build its pool; the pool never connects here
// because pool.query is replaced below.
process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';
process.env.TELEMETRY_RETENTION_DAYS = '90';

const { pool } = await import('./db.js');
const { runRollup } = await import('./rollup.js');

test('the rollup deletes instance_meta rows not seen within the retention window', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 1 }], rowCount: 0 };
  });

  await runRollup();

  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const metaDelete = calls.find((c) => /^DELETE FROM instance_meta\b/.test(c.sql));
  assert.ok(metaDelete, 'no DELETE FROM instance_meta was issued');
  assert.match(metaDelete.sql, /WHERE last_seen < \$1/);
  assert.deepEqual(metaDelete.params, [cutoff]);

  // It runs after instance_meta has been refreshed from the heartbeats,
  // so an instance seen inside the window keeps its row.
  const upsert = calls.findIndex((c) => c.sql.startsWith('INSERT INTO instance_meta'));
  assert.ok(upsert >= 0 && upsert < calls.indexOf(metaDelete));
});
