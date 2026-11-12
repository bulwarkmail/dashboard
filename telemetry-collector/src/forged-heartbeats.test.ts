// POST /v1/heartbeat takes no credential, so what one caller can make of it has to be bounded by the
// collector and by nginx. Real instances keep working: they send the current time and a release version.
//
// The last tests need a real Postgres and are skipped unless ROLLUP_TEST_PG=1 (the same switch and
// setup as rollup-late-heartbeats.test.ts). Run this file on its own then: the Postgres-backed test
// files share one database and empty its tables.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool, migrate } = await import('./db.js');
const { env } = await import('./env.js');
const { log } = await import('./log.js');
const { storeHeartbeat } = await import('./heartbeat.js');
const { promotePending } = await import('./pending.js');
const { isJsonRequest, validate, validateErrorBatch } = await import('./validate.js');

const v1 = {
  schema: '1',
  instance_id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
  ts: new Date().toISOString(),
  version: '1.21.1',
  build: 'release',
  platform: 'docker',
  node_version: '24.1.0',
  os_family: 'linux',
  stalwart_version: '0.16.27',
  features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
  counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
  uptime_days: 3,
};
const error = { name: 'TypeError', fingerprint: '0123456789abcdef', frames: [], version: '1.21.1', count: '1', days: 1 };
const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

interface Seen { sql: string; params: unknown[] }

/** The parameter bound to `column` in `INSERT INTO t (a, b) VALUES ($1, $2)`. */
function bound(call: Seen, column: string): unknown {
  const insert = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(call.sql);
  if (!insert) return undefined;
  const at = insert[1].split(',').map((s) => s.trim()).indexOf(column);
  const placeholder = /\$(\d+)/.exec(insert[2].split(',')[at] ?? '');
  return placeholder ? call.params[Number(placeholder[1]) - 1] : undefined;
}

/** Every day the collector would write for this body, arriving at `now`: heartbeat, instance and error-count rows. */
async function storedDays(t: import('node:test').TestContext, body: unknown, now = Date.now()): Promise<string[] | 'refused'> {
  const calls: Seen[] = [];
  const record = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  const first = t.mock.method(pool, 'query', record);
  const second = t.mock.method(pool, 'connect', async () => ({ query: record, release: () => {} }));
  try {
    const clean = validate(body, now);
    if (!clean) return 'refused';
    await storeHeartbeat(clean, now);
  } finally {
    first.mock.restore();
    second.mock.restore();
  }
  const days: string[] = [];
  for (const call of calls) {
    for (const column of ['day', 'first_seen', 'last_seen']) {
      const value = bound(call, column);
      if (typeof value === 'string') days.push(value.slice(0, 10));
    }
  }
  assert.ok(days.length > 0, 'the heartbeat was stored');
  return days;
}

test('a heartbeat is stored under the day it arrives, whatever day it claims', async (t) => {
  const allowed = new Set([utcDay(-2), utcDay(-1), utcDay(0), utcDay(1)]);
  for (const ts of ['1999-12-31T00:00:00Z', '2020-01-01T12:00:00Z', '2099-01-01T00:00:00Z', '9999-12-31T23:59:59Z', '+275760-09-13T00:00:00.000Z', '-000001-01-01T00:00:00Z', new Date(Date.now() + 3 * 86_400_000).toISOString(), new Date(Date.now() - 40 * 86_400_000).toISOString()]) {
    for (const body of [{ ...v1, ts }, { ...v1, schema: '2', ts, errors: [error] }]) {
      const days = await storedDays(t, body);
      if (days === 'refused') continue;
      // Stored under the arrival day (error counts under the day before it), or refused: never
      // under a day the caller picked.
      for (const day of days) assert.ok(allowed.has(day), `ts ${ts} (schema ${body.schema}) writes a row for ${day}`);
    }
  }
});

test('an instance whose clock is a few hours off still counts today or yesterday', async (t) => {
  const near = new Set([utcDay(-1), utcDay(0), utcDay(1)]);
  for (const ts of [new Date(Date.now() - 20 * 3600 * 1000).toISOString(), new Date(Date.now() + 2 * 3600 * 1000).toISOString(), 'not a date', undefined]) {
    const days = await storedDays(t, { ...v1, ts });
    assert.notEqual(days, 'refused', `a heartbeat with ts ${ts} was refused`);
    for (const day of days as string[]) assert.ok(near.has(day), `ts ${ts} writes a row for ${day}`);
  }
});

test('the day rule at the UTC day boundary', async (t) => {
  const at = (now: string, ts: string) => storedDays(t, { ...v1, ts }, Date.parse(now));
  // Just after midnight: the claimed day is kept when it is today or yesterday.
  assert.deepEqual(new Set(await at('2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')), new Set(['2026-11-10']));
  assert.deepEqual(new Set(await at('2026-11-10T00:00:00.000Z', '2026-11-09T23:59:59.000Z')), new Set(['2026-11-09']));
  assert.deepEqual(new Set(await at('2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')), new Set(['2026-11-10']));
  // Just before midnight: tomorrow and the day before yesterday become today.
  assert.deepEqual(new Set(await at('2026-11-10T23:59:59.000Z', '2026-11-11T00:00:00.000Z')), new Set(['2026-11-10']));
  assert.deepEqual(new Set(await at('2026-11-10T23:59:59.000Z', '2026-11-09T00:00:00.000Z')), new Set(['2026-11-09']));
  assert.deepEqual(new Set(await at('2026-11-10T23:59:59.000Z', '2026-11-08T23:59:59.000Z')), new Set(['2026-11-10']));
});

test('a schema 2 heartbeat for yesterday puts its error counts on the day before, never further back', async (t) => {
  const days = await storedDays(t, { ...v1, schema: '2', ts: '2026-11-09T23:50:00.000Z', errors: [error] }, Date.parse('2026-11-10T00:30:00Z'));
  assert.deepEqual(new Set(days), new Set(['2026-11-09', '2026-11-08']));
});

test('a version is a release number, not a text field', () => {
  // What instances send: webmail releases and betas, the desktop app's betas, its mark on error counts.
  for (const version of ['1.21.1', '1.21.0-beta.2', '1.11.0-beta.3', '0.1.0-beta.57', '0.1.92', '0.3.0-beta.1+desktop', '1.20.0+desktop', '1.20.0+desktop.abc1234', '10.200.3000', '9999.9999.9999']) {
    assert.equal(validate({ ...v1, version })?.version, version);
  }
  // A number part that doesn't fit an integer breaks every panel that sorts by version.
  for (const version of ['99999999999.0.0', '1.99999999999.0', '1.0.99999999999', '2147483648.0.0', '12345.0.0']) {
    assert.equal(validate({ ...v1, version }), null, version);
  }
  // Free text in the public version table: any prerelease or build part the project doesn't use.
  for (const version of [
    '999.0.0-BULWARK.IS.NOT.SAFE.see.evil-site.example',
    '1.0.0-see_evil-site.example_for_the_fix',
    '909.0.0-INVENTED.TEXT.see.some-site.example',
    '1.11.0-pre.3', '1.20.0-rc.2', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.1.2', '1.0.0-beta.x',
    '1.0.0+build', '1.0.0+desktop.not-hex', '1.0.0+desktop.ABCDEF1', '1.0.0+desktop+desktop',
    `1.0.0-${'a'.repeat(58)}`, `1.0.0-${'a'.repeat(100)}`, `1.0.0+${'a'.repeat(100)}`,
  ]) {
    assert.equal(validate({ ...v1, version }), null, version);
  }
});

test('the same bounds hold for the versions inside error counts', () => {
  const bad = { ...error, version: '99999999999.0.0' };
  assert.equal(validate({ ...v1, schema: '2', errors: [bad] }), null);
  assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [bad] }), null);
  assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [{ ...error, version: `1.0.0-${'a'.repeat(60)}` }] }), null);
  assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [{ ...error, version: '1.0.0-INVENTED.TEXT' }] }), null);
  // And an honest one still passes.
  assert.ok(validate({ ...v1, schema: '2', errors: [error] }));
  assert.ok(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [{ ...error, version: '0.1.0-beta.57+desktop' }] }));
});

test('only a request that says its body is JSON is read', () => {
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) assert.equal(isJsonRequest(type), true, type);
  // What a page can make a browser send without asking the collector first.
  for (const type of [undefined, '', 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    assert.equal(isJsonRequest(type), false, String(type));
  }
});

test('an error batch names today or yesterday, not a day of the caller\'s choice', () => {
  for (const day of ['1999-12-31', '2099-01-01', '9999-12-31', utcDay(5), utcDay(-30)]) {
    assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day, errors: [error] }), null, day);
  }
  assert.ok(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [error] }));
});

test('past 500 new instance ids a day, a new id\'s heartbeat is deferred, past 5500 dropped, and a known id is stored', async (t) => {
  const NOW = Date.parse('2026-11-10T12:00:00Z');
  // What Postgres answers to the admission query: a count for a new id, nothing for a known one.
  let newIdsToday = 500;
  const known = new Set(['a0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b']);
  const calls: Seen[] = [];
  const record = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: text, params });
    if (text.includes('INSERT INTO new_instance_counts')) {
      if (known.has(params[0] as string)) return { rows: [], rowCount: 0 };
      newIdsToday++;
      return { rows: [{ count: newIdsToday }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', record);
  t.mock.method(pool, 'connect', async () => ({ query: record, release: () => {} }));
  const warn = t.mock.method(log, 'warn', () => {});
  const heartbeat = (instance_id: string) => validate({ ...v1, instance_id, ts: new Date(NOW).toISOString() }, NOW)!;
  const stored = () => calls.filter((c) => c.sql.startsWith('INSERT INTO heartbeats')).length;
  const deferred = () => calls.filter((c) => c.sql.startsWith('INSERT INTO pending_heartbeats'));

  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000000501'), NOW), 'deferred', 'the 501st new id of the day was stored at once');
  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000000502'), NOW), 'deferred');
  assert.equal(stored(), 0);
  // Kept whole for later, under the heartbeat's day.
  assert.equal(deferred().length, 2);
  assert.deepEqual(deferred()[0].params.slice(0, 2), ['00000000-0000-4000-8000-000000000501', '2026-11-10']);
  assert.equal(JSON.parse(deferred()[0].params[2] as string).instance_id, '00000000-0000-4000-8000-000000000501');
  // One warning a day, not one per heartbeat.
  assert.equal(warn.mock.callCount(), 1);
  // The admission counts by the UTC day the heartbeat arrives.
  assert.equal(calls[0].params[1], '2026-11-10');
  // A known id is always stored.
  assert.equal(await storeHeartbeat(heartbeat('a0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b'), NOW), 'stored');
  assert.equal(stored(), 1);
  // Past the deferred ones too, a new id is dropped, with one more warning.
  newIdsToday = 500 + env.maxDeferredPerDay;
  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000005501'), NOW), 'dropped');
  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000005502'), NOW), 'dropped');
  assert.equal(deferred().length, 2);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(env.maxNewInstancesPerDay, 500);
  assert.equal(env.maxDeferredPerDay, 5000);
});

test('the telemetry vhost limits how fast one address can post', () => {
  // The collector never sees an address (nginx blanks X-Forwarded-For on purpose), so the limit lives in nginx.
  // limit_req keeps addresses in memory only; nothing is logged.
  const vhost = readFileSync(new URL('../../nginx/telemetry.conf.template', import.meta.url), 'utf8');
  const zones = new Map<string, number>();
  for (const m of vhost.matchAll(/limit_req_zone\s+\$binary_remote_addr\s+zone=(\w+):\w+\s+rate=(\d+)r\/([sm])\s*;/g)) {
    zones.set(m[1], Number(m[2]) * (m[3] === 's' ? 60 : 1));
  }
  assert.ok(zones.size > 0, 'no limit_req_zone keyed by the client address');
  for (const route of ['/v1/heartbeat', '/v1/errors']) {
    const at = vhost.indexOf(`location = ${route}`);
    assert.ok(at >= 0, `no location for ${route}`);
    const block = vhost.slice(at, vhost.indexOf('}', at));
    const use = /limit_req\s+zone=(\w+)(?:\s+burst=(\d+))?/.exec(block);
    assert.ok(use, `no limit_req in the ${route} location`);
    const perMinute = zones.get(use[1]);
    assert.ok(perMinute !== undefined, `${route} uses a zone that is not defined`);
    assert.ok(perMinute <= 30, `${route} allows ${perMinute} requests a minute per address`);
    assert.ok(Number(use[2] ?? 0) <= 20, `${route} allows a burst of ${use[2]}`);
  }
  assert.match(vhost, /limit_req_status\s+429\s*;/);
});

const withPg = process.env.ROLLUP_TEST_PG === '1';

after(async () => {
  if (withPg) await pool.end();
});

test('with Postgres: only the first new ids of a day are stored at once, known ids always are', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts');
  const max = env.maxNewInstancesPerDay;
  env.maxNewInstancesPerDay = 3;
  t.after(() => { env.maxNewInstancesPerDay = max; });
  t.mock.method(log, 'warn', () => {});
  const now = Date.now();
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  const results: string[] = [];
  for (const id of ids) results.push(await storeHeartbeat(validate({ ...v1, instance_id: id, ts: new Date(now).toISOString() }, now)!, now));
  assert.deepEqual(results, ['stored', 'stored', 'stored', 'deferred', 'deferred']);
  // The first one again (known now), and a schema 2 heartbeat of a known id.
  assert.equal(await storeHeartbeat(validate({ ...v1, instance_id: ids[0], ts: new Date(now).toISOString() }, now)!, now), 'stored');
  assert.equal(await storeHeartbeat(validate({ ...v1, schema: '2', instance_id: ids[1], ts: new Date(now).toISOString(), errors: [error] }, now)!, now), 'stored');
  const { rows } = await pool.query<{ n: number }>('SELECT count(DISTINCT instance_id)::int AS n FROM heartbeats');
  assert.equal(rows[0].n, 3);
  const counted = await pool.query<{ count: number }>('SELECT count FROM new_instance_counts WHERE day = $1', [new Date(now).toISOString().slice(0, 10)]);
  assert.equal(counted.rows[0].count, 5);
  const waiting = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pending_heartbeats');
  assert.equal(waiting.rows[0].n, 2);
});

test('with Postgres: a deferred heartbeat is counted later, and the day\'s budget holds', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats, error_counts');
  const max = env.maxNewInstancesPerDay;
  env.maxNewInstancesPerDay = 3;
  t.after(() => { env.maxNewInstancesPerDay = max; });
  t.mock.method(log, 'warn', () => {});
  t.mock.method(log, 'info', () => {});
  const DAY = 86_400_000;
  const day0 = Date.parse(`${utcDay(-6)}T12:00:00Z`);
  const day1 = day0 + DAY;
  const day2 = day0 + 2 * DAY;
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const id = () => crypto.randomUUID();
  const send = (instance_id: string, at: number, extra: Record<string, unknown> = {}) =>
    storeHeartbeat(validate({ ...v1, instance_id, ts: new Date(at).toISOString(), ...extra }, at)!, at);
  const days = async (instance_id: string) => (await pool.query<{ d: string }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS d FROM heartbeats WHERE instance_id = $1 ORDER BY day", [instance_id])).rows.map((r) => r.d);

  // Day 0: three new ids are stored, five wait (the last one a schema 2 heartbeat, which waits
  // without its error counts).
  const [a, b, c] = [id(), id(), id()];
  const waiting = [id(), id(), id(), id(), id()];
  for (const x of [a, b, c]) assert.equal(await send(x, day0), 'stored');
  for (const x of waiting.slice(0, 4)) assert.equal(await send(x, day0), 'deferred');
  assert.equal(await send(waiting[4], day0, { schema: '2', errors: [error] }), 'deferred');
  // Nothing waits long enough yet, and none came back.
  assert.equal(await promotePending(day0), 0);

  // Day 1: the day's three new ids come first; four of the waiting ones send again and wait again.
  for (const x of [id(), id(), id()]) assert.equal(await send(x, day1), 'stored');
  for (const x of waiting.slice(0, 4)) assert.equal(await send(x, day1), 'deferred');
  assert.equal(await send(a, day1), 'stored');
  // Those that came back are counted, oldest first, as many as the day's budget of three.
  assert.equal(await promotePending(day1), 3);
  for (const x of waiting.slice(0, 3)) assert.deepEqual(await days(x), [dayOf(day0), dayOf(day1)]);
  assert.deepEqual(await days(waiting[3]), []);
  const meta = await pool.query<{ d: string }>("SELECT to_char(first_seen, 'YYYY-MM-DD') AS d FROM instance_meta WHERE instance_id = $1", [waiting[0]]);
  assert.equal(meta.rows[0].d, dayOf(day0));
  assert.equal(await promotePending(day1), 0, 'the day\'s budget was used up');

  // Day 2: the one that came back, then the one that sent once and waited two days.
  assert.equal(await promotePending(day2), 2);
  assert.deepEqual(await days(waiting[3]), [dayOf(day0), dayOf(day1)]);
  assert.deepEqual(await days(waiting[4]), [dayOf(day0)]);
  const errors = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM error_counts WHERE instance_id = $1', [waiting[4]]);
  assert.equal(errors.rows[0].n, 0, 'a waiting heartbeat kept its error counts');
  const left = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pending_heartbeats');
  assert.equal(left.rows[0].n, 0);
  const promoted = await pool.query<{ d: string; promoted: number }>("SELECT to_char(day, 'YYYY-MM-DD') AS d, promoted FROM new_instance_counts ORDER BY day");
  assert.deepEqual(promoted.rows.map((r) => [r.d, r.promoted]), [[dayOf(day0), 0], [dayOf(day1), 3], [dayOf(day2), 2]]);
});

test('with Postgres: one instance brings in at most its share of the day\'s error forwards', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE error_counts, error_forwards, error_instant_forwards, error_forward_senders');
  const dsn = env.bugsinkTelemetryDsn;
  env.bugsinkTelemetryDsn = 'https://77896adcc21c4520acff7ea093e42b2d@bugsink.example.org/2';
  t.after(() => { env.bugsinkTelemetryDsn = dsn; });
  t.mock.method(log, 'info', () => {});
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body).trim().split('\n')[2]).fingerprint[1]);
    return new Response(null, { status: 200 });
  });
  const { runForward } = await import('./forward.js');
  const { forwardInstant } = await import('./instant.js');
  const now = Date.now();
  const complete = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10);
  const [one, other, third] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const row = (instance: string, fingerprint: string) => pool.query(
    `INSERT INTO error_counts (instance_id, day, fingerprint, version, name, frames, count_bucket, days)
     VALUES ($1, $2, $3, '1.21.1', 'TypeError', '[]', '1', 1)`, [instance, complete, fingerprint]);
  // Fifteen groups only one instance reports, and one that two others report. The collector has
  // known `one` for a month, so its instant batches may go at once.
  await pool.query('INSERT INTO instance_arrivals (instance_id, first_day) VALUES ($1, current_date - 30)', [one]);
  for (let i = 0; i < 15; i++) await row(one, i.toString(16).padStart(16, '0'));
  await row(other, 'fedcba9876543210');
  await row(third, 'fedcba9876543210');

  assert.deepEqual(await runForward(now), { forwarded: 11, failed: 0 });
  // The group two instances reported went first.
  assert.equal(sent[0], 'fedcba9876543210');
  const share = await pool.query<{ id: string; count: number }>('SELECT instance_id::text AS id, count FROM error_forward_senders');
  assert.equal(share.rows.find((r) => r.id === one)?.count, 10);
  // The rest wait: the next run reads none of them today.
  assert.deepEqual(await runForward(now + 60_000), { forwarded: 0, failed: 0 });
  // The same share holds for the instance's instant batches.
  const batch = validateErrorBatch({ schema: '1', instance_id: one, day: utcDay(), errors: [{ ...error, fingerprint: 'aaaaaaaaaaaaaaaa' }] })!;
  assert.deepEqual(await forwardInstant(batch, now + 120_000), { forwarded: 0, failed: 0 });
  const claims = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM error_instant_forwards');
  assert.equal(claims.rows[0].n, 0, 'the claim was not given back');
});
