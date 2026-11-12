// Needs a real Postgres, like rollup-late-heartbeats.test.ts (same switch and setup; skipped
// unless ROLLUP_TEST_PG=1), and a free local port (TEST_TELEMETRY_PORT, default 3839): it starts
// the collector itself and posts to it, so it holds for any place the rule is implemented in.
//
// Run this file on its own: the Postgres-backed test files share one database and empty its tables.
//
// At most TELEMETRY_MAX_NEW_INSTANCES_PER_DAY instance ids the collector has not seen before are
// stored per UTC day. That holds for both ways in: an instant error batch (POST /v1/errors) from an
// id the collector doesn't know takes one of those places, and past them it is refused with 429 (the
// webmail and the desktop app keep it for a later try) and not stored. A known instance's batch is
// always stored.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const withPg = process.env.ROLLUP_TEST_PG === '1';
const port = Number(process.env.TEST_TELEMETRY_PORT ?? 3839);
const base = `http://127.0.0.1:${port}`;
const MAX = 3;

const { pool, migrate } = await import('./db.js');

const utcDay = () => new Date().toISOString().slice(0, 10);
const heartbeat = (id: string) => ({
  schema: '1', instance_id: id, ts: new Date().toISOString(), version: '1.21.1', build: 'release', platform: 'docker',
  node_version: '24.1.0', os_family: 'linux', stalwart_version: '0.16.27',
  features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
  counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
  uptime_days: 3,
});
const batch = (id: string, n: number) => ({
  schema: '1', instance_id: id, day: utcDay(),
  errors: [{ name: 'TypeError', fingerprint: n.toString(16).padStart(16, '0'), frames: [], version: '1.21.1', count: '1', days: 1 }],
});

async function post(path: string, body: unknown, type = 'application/json'): Promise<number> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  await res.text();
  return res.status;
}
async function errorRows(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM error_counts WHERE instance_id = $1', [id]);
  return rows[0].n;
}

let server: ChildProcess | undefined;

before(async () => {
  if (!withPg) return;
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts, error_forwards, error_instant_forwards');
  server = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, TELEMETRY_PORT: String(port), TELEMETRY_MAX_NEW_INSTANCES_PER_DAY: String(MAX), BUGSINK_TELEMETRY_DSN: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the collector did not start on port ${port}`);
});

after(async () => {
  server?.kill();
  if (withPg) await pool.end();
});

test('with Postgres: past the day\'s limit of new ids, an error batch from an id never seen is refused and not stored', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  // The day's new ids, and one more that has to wait.
  const known = Array.from({ length: MAX }, () => crypto.randomUUID());
  for (const id of known) assert.equal(await post('/v1/heartbeat', heartbeat(id)), 200);
  const waiting = crypto.randomUUID();
  assert.equal(await post('/v1/heartbeat', heartbeat(waiting)), 200);
  const stored = await pool.query<{ n: number }>('SELECT count(DISTINCT instance_id)::int AS n FROM heartbeats');
  assert.equal(stored.rows[0].n, MAX, 'the heartbeat limit itself did not hold');

  // The same caller turns to the other route with ids the collector has never seen.
  const strangers = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const [i, id] of strangers.entries()) assert.equal(await post('/v1/errors', batch(id, 100 + i)), 429, 'refused in a way the senders keep the batch for later');
  assert.equal(await post('/v1/errors', batch(waiting, 200)), 429);
  for (const id of [...strangers, waiting]) {
    assert.equal(await errorRows(id), 0, 'an instance id the collector never saw, past the day\'s limit, got rows in error_counts');
  }

  // An instance the collector knows is not affected.
  assert.equal(await post('/v1/errors', batch(known[0], 300)), 200);
  assert.equal(await errorRows(known[0]), 1);
});

test('with Postgres: a heartbeat or error batch that doesn\'t say it is JSON is refused and stores nothing', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  // What a web page can make its visitors' browsers send without a preflight.
  const id = crypto.randomUUID();
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded']) {
    assert.equal(await post('/v1/heartbeat', heartbeat(id), type), 415, type);
  }
  const rows = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM heartbeats WHERE instance_id = $1', [id]);
  assert.equal(rows.rows[0].n, 0);
  const known = (await pool.query<{ id: string }>('SELECT instance_id::text AS id FROM heartbeats LIMIT 1')).rows[0].id;
  assert.equal(await post('/v1/errors', batch(known, 400), 'text/plain'), 415);
  assert.equal(await errorRows(known), 1, 'only the batch of the first test is stored');
});
