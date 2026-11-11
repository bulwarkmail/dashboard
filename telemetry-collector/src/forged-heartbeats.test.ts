// POST /v1/heartbeat takes no credential, so what one caller can make of it has to be bounded by the
// collector and by nginx. Real instances keep working: they send the current time and a release version.
//
// The last test needs a real Postgres and is skipped unless ROLLUP_TEST_PG=1 (the same switch and
// setup as rollup-late-heartbeats.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool, migrate } = await import('./db.js');
const { env } = await import('./env.js');
const { log } = await import('./log.js');
const { storeHeartbeat } = await import('./heartbeat.js');
const { validate, validateErrorBatch } = await import('./validate.js');

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
  // What instances send.
  for (const version of ['1.21.1', '1.21.0-beta.2', '0.1.92', '1.20.0+desktop.abc1234', '1.11.0-pre.3', '10.200.3000', '9999.9999.9999', `1.0.0-${'a'.repeat(58)}`]) {
    assert.equal(validate({ ...v1, version })?.version, version);
  }
  // A number part that doesn't fit an integer breaks every panel that sorts by version.
  for (const version of ['99999999999.0.0', '1.99999999999.0', '1.0.99999999999', '2147483648.0.0', '12345.0.0']) {
    assert.equal(validate({ ...v1, version }), null, version);
  }
  // Free text in the public version table.
  assert.equal(validate({ ...v1, version: '999.0.0-BULWARK.IS.NOT.SAFE.see.evil-site.example.and.more.text.to.fill.the.public.table' }), null);
  assert.equal(validate({ ...v1, version: `1.0.0-${'a'.repeat(100)}` }), null);
  assert.equal(validate({ ...v1, version: `1.0.0+${'a'.repeat(100)}` }), null);
  // 64 characters in all: a 60-character prerelease or build part is too long.
  assert.equal(validate({ ...v1, version: `1.0.0-${'a'.repeat(60)}` }), null);
  assert.equal(validate({ ...v1, version: `1.0.0+${'a'.repeat(60)}` }), null);
});

test('the same bounds hold for the versions inside error counts', () => {
  const bad = { ...error, version: '99999999999.0.0' };
  assert.equal(validate({ ...v1, schema: '2', errors: [bad] }), null);
  assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [bad] }), null);
  assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [{ ...error, version: `1.0.0-${'a'.repeat(60)}` }] }), null);
  // And an honest one still passes.
  assert.ok(validate({ ...v1, schema: '2', errors: [error] }));
});

test('an error batch names today or yesterday, not a day of the caller\'s choice', () => {
  for (const day of ['1999-12-31', '2099-01-01', '9999-12-31', utcDay(5), utcDay(-30)]) {
    assert.equal(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day, errors: [error] }), null, day);
  }
  assert.ok(validateErrorBatch({ schema: '1', instance_id: v1.instance_id, day: utcDay(), errors: [error] }));
});

test('past 500 new instance ids a day, a new id is answered and not stored, and a known id still is', async (t) => {
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

  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000000501'), NOW), false, 'the 501st new id of the day was stored');
  assert.equal(await storeHeartbeat(heartbeat('00000000-0000-4000-8000-000000000502'), NOW), false);
  assert.equal(stored(), 0);
  // One warning a day, not one per heartbeat.
  assert.equal(warn.mock.callCount(), 1);
  // The admission counts by the UTC day the heartbeat arrives.
  assert.equal(calls[0].params[1], '2026-11-10');
  // A known id is always stored.
  assert.equal(await storeHeartbeat(heartbeat('a0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b'), NOW), true);
  assert.equal(stored(), 1);
  assert.equal(env.maxNewInstancesPerDay, 500);
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

test('with Postgres: only the first new ids of a day are stored, known ids always are', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async (t) => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts');
  const max = env.maxNewInstancesPerDay;
  env.maxNewInstancesPerDay = 3;
  t.after(() => { env.maxNewInstancesPerDay = max; });
  t.mock.method(log, 'warn', () => {});
  const now = Date.now();
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  const results: boolean[] = [];
  for (const id of ids) results.push(await storeHeartbeat(validate({ ...v1, instance_id: id, ts: new Date(now).toISOString() }, now)!, now));
  assert.deepEqual(results, [true, true, true, false, false]);
  // The first one again (known now), and a schema 2 heartbeat of a known id.
  assert.equal(await storeHeartbeat(validate({ ...v1, instance_id: ids[0], ts: new Date(now).toISOString() }, now)!, now), true);
  assert.equal(await storeHeartbeat(validate({ ...v1, schema: '2', instance_id: ids[1], ts: new Date(now).toISOString(), errors: [error] }, now)!, now), true);
  const { rows } = await pool.query<{ n: number }>('SELECT count(DISTINCT instance_id)::int AS n FROM heartbeats');
  assert.equal(rows[0].n, 3);
  const counted = await pool.query<{ count: number }>('SELECT count FROM new_instance_counts WHERE day = $1', [new Date(now).toISOString().slice(0, 10)]);
  assert.equal(counted.rows[0].count, 5);
});
