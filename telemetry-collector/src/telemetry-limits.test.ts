// How the telemetry collector admits instance ids it doesn't know yet, against a real Postgres,
// like rollup-late-heartbeats.test.ts (skipped unless ROLLUP_TEST_PG=1, PG_PORT pointing at a
// throwaway Postgres). The first test also needs a free local port (TEST_TELEMETRY_PORT, default
// 3838): it starts the collector and posts to it. Run this file on its own: the Postgres-backed test
// files share one database and empty its tables.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool, migrate } = await import('./db.js');
const { env } = await import('./env.js');
const { log } = await import('./log.js');
const { admitErrorSender, storeHeartbeat } = await import('./heartbeat.js');
const { storeInstantErrors } = await import('./instant.js');
const { runRollup } = await import('./rollup.js');
const { validate, validateErrorBatch } = await import('./validate.js');

const withPg = process.env.ROLLUP_TEST_PG === '1';
const skip = !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres';
const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const heartbeat = (instance_id: string, ts = new Date().toISOString()) => ({
  schema: '1', instance_id, ts, version: '1.21.1', build: 'release', platform: 'docker',
  node_version: '24.1.0', os_family: 'linux', stalwart_version: '0.16.27',
  features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
  counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
  uptime_days: 3,
});

after(async () => {
  if (withPg) await pool.end();
});

// The desktop app sends crash reports with their own consent, separate from telemetry: with
// crash reports on and telemetry off it sends POST /v1/errors and never a heartbeat
// (webmail lib/telemetry/state.ts effectiveErrorsConsent, lib/desktop/desktop-telemetry.ts
// buildDesktopErrorBatch: "the collector's /v1/errors takes this without a heartbeat, so it works
// with telemetry off"). On a day with places left for new ids, such a batch is kept.
test('with Postgres: a desktop app\'s crash report counts are kept without a heartbeat, on a day with room for new ids', { skip }, async () => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts, error_forwards, error_instant_forwards, error_forward_senders');
  const port = Number(process.env.TEST_TELEMETRY_PORT ?? 3838);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, TELEMETRY_PORT: String(port), BUGSINK_TELEMETRY_DSN: '' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    assert.ok(up, `the collector did not start on port ${port}`);
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/v1/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await res.text();
      return res.status;
    };
    const rows = async (id: string) => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM error_counts WHERE instance_id = $1', [id])).rows[0].n;

    // The shell's own batch (instance mode): buildDesktopErrorBatch, its own random id.
    const shell = crypto.randomUUID();
    assert.equal(await post({ schema: '1', instance_id: shell, day: utcDay(), errors: [
      { name: 'Error', fingerprint: '1234567890abcdef', frames: [], version: '0.3.0-beta.1+desktop', count: '2-5', days: 1 },
    ] }), 200);
    // The embedded server's instant batch (standalone mode, telemetry off): the webmail's version with +desktop.
    const embedded = crypto.randomUUID();
    assert.equal(await post({ schema: '1', instance_id: embedded, day: utcDay(), errors: [
      { name: 'TypeError', fingerprint: 'abcdef1234567890', frames: [{ path: '/_next/static/chunks/app-1.js', line: 1, col: 2, debug_id: null }], version: '1.21.1+desktop', count: '1', days: 1 },
    ] }), 200);

    assert.equal(await rows(shell), 1, 'the desktop shell\'s crash report counts were answered 200 and thrown away');
    assert.equal(await rows(embedded), 1, 'the embedded webmail\'s crash report counts were answered 200 and thrown away');
  } finally {
    server.kill();
  }
});

// An error sender the collector doesn't know takes one of the day's places for new ids, the same
// places heartbeats take, and is known from then on. Once the places are used up its batch is
// refused, however often it tries again, and the refusals take nothing from the places of the
// heartbeats that wait. A waiting id whose batch gets a place on a later day has its waiting
// heartbeat stored with it.
test('with Postgres: an unknown error sender takes one place for new ids, and a refused one takes no waiting place', { skip }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts');
  const saved = { max: env.maxNewInstancesPerDay, deferred: env.maxDeferredPerDay };
  env.maxNewInstancesPerDay = 3;
  env.maxDeferredPerDay = 5;
  t.after(() => { env.maxNewInstancesPerDay = saved.max; env.maxDeferredPerDay = saved.deferred; });
  t.mock.method(log, 'warn', () => {});
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const counted = async (day: string) => (await pool.query<{ count: number }>('SELECT count FROM new_instance_counts WHERE day = $1', [day])).rows[0]?.count ?? 0;
  const batch = (id: string, at: number) => validateErrorBatch({ schema: '1', instance_id: id, day: new Date(at).toISOString().slice(0, 10), errors: [
    { name: 'Error', fingerprint: '1234567890abcdef', frames: [], version: '0.3.0-beta.1+desktop', count: '1', days: 1 },
  ] }, at)!;
  const send = (id: string) => storeHeartbeat(validate(heartbeat(id, new Date(now).toISOString()), now)!, now);

  // A crash report sender: one place, and its heartbeat, should it send one, takes no second one.
  const sender = crypto.randomUUID();
  assert.equal(await admitErrorSender(sender, now), true);
  await storeInstantErrors(batch(sender, now));
  assert.equal(await admitErrorSender(sender, now), true);
  assert.equal(await send(sender), 'stored');
  assert.equal(await counted(today), 1);

  // The day's other two places; then strangers' batches are refused, also when they try again.
  for (let i = 0; i < 2; i++) assert.equal(await send(crypto.randomUUID()), 'stored');
  const strangers = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (let round = 0; round < 3; round++) {
    for (const id of strangers) assert.equal(await admitErrorSender(id, now), false);
  }
  assert.equal(await counted(today), 3, 'refused batches were counted');
  // A new installation's heartbeat still waits.
  const waiting = crypto.randomUUID();
  assert.equal(await send(waiting), 'deferred');

  // The next day the waiting installation's batch gets a place, and its heartbeat is stored with it.
  const tomorrow = now + 86_400_000;
  assert.equal(await admitErrorSender(waiting, tomorrow), true);
  const stored = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM heartbeats WHERE instance_id = $1', [waiting]);
  assert.equal(stored.rows[0].n, 1);
  const left = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pending_heartbeats WHERE instance_id = $1', [waiting]);
  assert.equal(left.rows[0].n, 0);
});

// The waiting list exists so that an honest new installation is late on a busy day instead of
// lost (pending.ts). Its daily limit bounds rows, one per id and day; a single id sending the same
// heartbeat again and again adds no row and must not use up the places of other ids.
test('with Postgres: one id sending again and again past the limit takes one place in the waiting list, not all of them', { skip }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats');
  const saved = { max: env.maxNewInstancesPerDay, deferred: env.maxDeferredPerDay };
  env.maxNewInstancesPerDay = 3;
  env.maxDeferredPerDay = 5;
  t.after(() => { env.maxNewInstancesPerDay = saved.max; env.maxDeferredPerDay = saved.deferred; });
  t.mock.method(log, 'warn', () => {});
  const now = Date.now();
  const send = (id: string) => storeHeartbeat(validate(heartbeat(id), now)!, now);

  for (let i = 0; i < 3; i++) assert.equal(await send(crypto.randomUUID()), 'stored');
  const repeater = crypto.randomUUID();
  for (let i = 0; i < 10; i++) await send(repeater);
  const pending = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pending_heartbeats');
  assert.equal(pending.rows[0].n, 1, 'one id, one day: one waiting row');

  const honest = crypto.randomUUID();
  assert.equal(await send(honest), 'deferred', 'a new installation was dropped after one other id sent ten times');
});

// A waiting heartbeat is kept without its error counts, so a waiting row stays a few hundred bytes
// whatever the heartbeat carried, and waiting rows go after a week.
test('with Postgres: a waiting heartbeat is kept without its error counts, for a week', { skip }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts');
  const saved = env.maxNewInstancesPerDay;
  env.maxNewInstancesPerDay = 0;
  t.after(() => { env.maxNewInstancesPerDay = saved; });
  t.mock.method(log, 'warn', () => {});
  t.mock.method(log, 'info', () => {});
  const DAY = 86_400_000;
  const now = Date.now();
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  // About the largest schema 2 heartbeat a 64 KiB body holds: 50 errors of five frames each.
  const errors = Array.from({ length: 50 }, (_, i) => ({
    name: 'TypeError', fingerprint: (i + 1).toString(16).padStart(16, '0'), version: '1.21.1', count: '201+', days: 7,
    frames: Array.from({ length: 5 }, () => ({ path: `/_next/static/chunks/${crypto.randomBytes(48).toString('hex')}.js`, line: 1234567, col: 7654321, debug_id: crypto.randomUUID() })),
  }));
  const body = { ...heartbeat(crypto.randomUUID(), new Date(now).toISOString()), schema: '2', errors };
  assert.ok(JSON.stringify(body).length < 64 * 1024);
  assert.equal(await storeHeartbeat(validate(body, now)!, now), 'deferred');
  const row = await pool.query<{ bytes: number; errors: boolean }>("SELECT pg_column_size(heartbeat)::int AS bytes, heartbeat ? 'errors' AS errors FROM pending_heartbeats");
  assert.ok(row.rows[0].bytes < 1000, `a waiting row takes ${row.rows[0].bytes} bytes`);
  assert.equal(row.rows[0].errors, false, 'the waiting row holds the error counts');

  // A week on, the rollup deletes it; a row of six days ago stays.
  const [old, recent] = [crypto.randomUUID(), crypto.randomUUID()];
  await pool.query("INSERT INTO pending_heartbeats (instance_id, day, heartbeat) VALUES ($1, $2, '{}'), ($3, $4, '{}')",
    [old, dayOf(now - 8 * DAY), recent, dayOf(now - 6 * DAY)]);
  await runRollup(now);
  const left = await pool.query<{ id: string }>('SELECT instance_id::text AS id FROM pending_heartbeats');
  const ids = left.rows.map((r) => r.id);
  assert.ok(ids.includes(recent), 'a row of six days ago was deleted');
  assert.ok(!ids.includes(old), 'a row of eight days ago is still waiting');
});
