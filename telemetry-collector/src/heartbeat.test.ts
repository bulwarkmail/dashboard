import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool } = await import('./db.js');
const { storeHeartbeat, dayBefore } = await import('./heartbeat.js');
const { validate } = await import('./validate.js');

const v1 = {
  schema: '1',
  instance_id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
  ts: '2026-11-10T08:12:00.000Z',
  version: '1.20.0',
};

const error = {
  name: 'TypeError',
  fingerprint: '0123456789abcdef',
  frames: [{ path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: null }],
  version: '1.20.0',
  count: '2-5',
  days: 1,
};

function mockDb(t: import('node:test').TestContext) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const record = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', record);
  t.mock.method(pool, 'connect', async () => ({ query: record, release: () => {} }));
  return calls;
}

test('a v1 heartbeat is stored as before and touches no error table', async (t) => {
  const calls = mockDb(t);
  await storeHeartbeat(validate(v1)!);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].sql.startsWith('INSERT INTO heartbeats'));
  assert.equal(JSON.parse(calls[0].params[2] as string).schema, '1');
  assert.equal(calls.some((c) => c.sql.includes('error_counts')), false);
});

test('a v2 heartbeat stores its errors for the day before, replacing that day\'s rows', async (t) => {
  const calls = mockDb(t);
  await storeHeartbeat(validate({ ...v1, schema: '2', errors: [error] })!);
  const heartbeat = JSON.parse(calls[0].params[2] as string);
  assert.equal('errors' in heartbeat, false);
  assert.deepEqual(calls.map((c) => c.sql.split(' ').slice(0, 3).join(' ')), [
    'INSERT INTO heartbeats', 'INSERT INTO instance_meta', 'BEGIN', 'DELETE FROM error_counts', 'INSERT INTO error_counts', 'COMMIT',
  ]);
  const insert = calls.find((c) => c.sql.startsWith('INSERT INTO error_counts'))!;
  assert.deepEqual(insert.params.slice(0, 5), ['f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', '2026-11-09', '0123456789abcdef', '1.20.0', 'TypeError']);
});

test('dayBefore crosses month ends', () => {
  assert.equal(dayBefore('2026-12-01'), '2026-11-30');
});

const desktop = { ...v1, platform: 'desktop', build: 'desktop.instance.stable' };

test('a desktop heartbeat keeps only the day it arrived, not the time', async (t) => {
  const calls = mockDb(t);
  await storeHeartbeat(validate(desktop)!);
  assert.match(calls[0].sql, /VALUES \(\$1, \$2, \$3::jsonb, date_trunc\('day', now\(\)\)\)/);
  assert.match(calls[0].sql, /received_at = date_trunc\('day', now\(\)\)/);
});

test('a server\'s heartbeat keeps its time, as before', async (t) => {
  const calls = mockDb(t);
  await storeHeartbeat(validate({ ...v1, platform: 'docker' })!);
  assert.match(calls[0].sql, /VALUES \(\$1, \$2, \$3::jsonb, now\(\)\)/);
  assert.equal(calls[0].sql.includes('date_trunc'), false);
});

test('a desktop heartbeat isn\'t counted among the instances ever seen', async (t) => {
  const calls = mockDb(t);
  await storeHeartbeat(validate(desktop)!);
  assert.equal(calls.some((c) => c.sql.includes('instance_meta')), false);
});
