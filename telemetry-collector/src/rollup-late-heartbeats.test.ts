// Needs a real Postgres: the question is what the rollup's own SQL does with days that already have
// a row, and a mocked pool can't answer that. Skipped unless ROLLUP_TEST_PG=1. To run it:
//
//   docker run -d --rm --name rollup-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=telemetry \
//     -e POSTGRES_DB=telemetry -p 127.0.0.1:<port>:5432 postgres:16-alpine
//   ROLLUP_TEST_PG=1 PG_PORT=<port> POSTGRES_TELEMETRY_PASSWORD=test node --import tsx --test src/rollup-late-heartbeats.test.ts
//   docker rm -f -v rollup-test-pg
//
// Run it with TZ=UTC and with TZ=Europe/Berlin: the driver reads a `date` column back as a
// JavaScript Date at local midnight.
//
// daily_rollups is the only table kept past the retention window, so each day's row has to hold
// every instance that reported on that day, also the ones that reported after the job first ran.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const enabled = process.env.ROLLUP_TEST_PG === '1';
process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool, migrate } = await import('./db.js');
const { runRollup } = await import('./rollup.js');

const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function heartbeats(day: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const payload = {
      schema: '1', instance_id: crypto.randomUUID(), ts: `${day}T00:00:00.000Z`, version: '1.21.1', build: 'release', platform: 'docker',
      node_version: '24.1.0', os_family: 'linux', stalwart_version: '0.16.27',
      features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
      counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
      uptime_days: 3,
    };
    await pool.query('INSERT INTO heartbeats (instance_id, day, payload) VALUES ($1, $2, $3::jsonb)', [payload.instance_id, day, JSON.stringify(payload)]);
  }
}

async function rolledUp(day: string): Promise<number | null> {
  const { rows } = await pool.query<{ active_instances: number }>('SELECT active_instances FROM daily_rollups WHERE day = $1', [day]);
  return rows[0]?.active_instances ?? null;
}

before(async () => {
  if (!enabled) return;
  await migrate();
  await pool.query('TRUNCATE heartbeats, daily_rollups, instance_meta, expired_instances');
});

after(async () => {
  await pool.end();
});

test('a day that is still going on gets no final row, and a finished day counts everyone who reported on it', { skip: !enabled && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  const today = utcDay();
  const yesterday = utcDay(-1);
  const lastWeek = utcDay(-7);
  await heartbeats(lastWeek, 2);
  await heartbeats(yesterday, 3);
  await heartbeats(today, 3);
  await runRollup();
  assert.equal(await rolledUp(lastWeek), 2);
  assert.equal(await rolledUp(yesterday), 3);

  // More instances report: two for today, and one whose heartbeat for yesterday came in late
  // (its clock, or a queue on the way).
  await heartbeats(today, 2);
  await heartbeats(yesterday, 1);
  await runRollup();
  assert.equal(await rolledUp(yesterday), 4, 'yesterday keeps the count from the first run');
  const todayRow = await rolledUp(today);
  assert.ok(todayRow === null || todayRow === 5, `today is rolled up as ${todayRow} while 5 instances reported`);

  // The next day's run (simulated by moving every row one day back) settles what was "today".
  await pool.query("UPDATE heartbeats SET day = day - 1, payload = jsonb_set(payload, '{ts}', to_jsonb(to_char(day - 1, 'YYYY-MM-DD') || 'T00:00:00.000Z'))");
  await pool.query('DELETE FROM daily_rollups WHERE day = $1', [today]);
  await pool.query('UPDATE daily_rollups SET day = day - 1');
  await runRollup();
  assert.equal(await rolledUp(yesterday), 5, 'the day that ended has every instance that reported on it');
  // An old day is not recomputed again and again: its row is as it was.
  assert.equal(await rolledUp(utcDay(-8)), 2);
});

test('a day in the future gets no row', { skip: !enabled && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  // Rows an older collector stored under a day the caller named.
  await heartbeats(utcDay(1), 2);
  await heartbeats('2099-01-01', 1);
  await runRollup();
  assert.equal(await rolledUp(utcDay(1)), null);
  assert.equal(await rolledUp('2099-01-01'), null);
  assert.equal(await rolledUp(utcDay()), null);
});
