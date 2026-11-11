import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool } = await import('./db.js');
const { env } = await import('./env.js');
const { validateErrorBatch } = await import('./validate.js');
const { InstanceLimiter, forwardInstant, resetInstantForTests, storeInstantErrors } = await import('./instant.js');

const INSTANCE = 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b';
const NOW = Date.parse('2026-11-10T08:12:00Z');
const DSN = 'https://77896adcc21c4520acff7ea093e42b2d@bugsink.example.org/2';

const error = {
  name: 'TypeError',
  fingerprint: '0123456789abcdef',
  frames: [{ path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2' }],
  version: '1.20.0',
  count: '1',
  days: 1,
};
const batch = { schema: '1', instance_id: INSTANCE, day: '2026-11-10', errors: [error] };

function mockDb(t: import('node:test').TestContext, claimed: (params: unknown[]) => boolean = () => true) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const record = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO error_instant_forwards')) {
      return claimed(params) ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // The instance still has its share of the day's forwards.
    if (sql.includes('INSERT INTO error_forward_senders')) return { rows: [{ instance_id: INSTANCE }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', record);
  t.mock.method(pool, 'connect', async () => ({ query: record, release: () => {} }));
  return calls;
}

test('a batch of the current day passes; only its own fields are kept', () => {
  assert.deepEqual(validateErrorBatch(batch, NOW), {
    instance_id: INSTANCE,
    day: '2026-11-10',
    errors: [{ ...error, message: null }],
  });
  // Shortly after midnight the previous day's last counts may still come in.
  assert.ok(validateErrorBatch({ ...batch, day: '2026-11-09' }, NOW));
});

test('anything else rejects the batch', () => {
  const bad: unknown[] = [
    null,
    { ...batch, schema: '2' },
    { ...batch, extra: 1 },
    { ...batch, instance_id: 'not-a-uuid' },
    { ...batch, day: '2026-11-08' },
    { ...batch, day: '2026-11-11' },
    { ...batch, day: 'today' },
    { ...batch, errors: [] },
    { ...batch, errors: [error, error] },
    { ...batch, errors: Array.from({ length: 51 }, (_, i) => ({ ...error, fingerprint: i.toString(16).padStart(16, '0') })) },
    { ...batch, errors: [{ ...error, message: 'Merger plans for Acme' }] },
    { ...batch, errors: [{ ...error, frames: [{ ...error.frames[0], path: 'https://x.example/a.js' }] }] },
    { ...batch, errors: [{ ...error, mail: 'x' }] },
  ];
  for (const input of bad) assert.equal(validateErrorBatch(input, NOW), null, JSON.stringify(input));
});

test('the counts are stored for the instance and day, replacing what it sent before', async (t) => {
  const calls = mockDb(t);
  await storeInstantErrors(validateErrorBatch(batch, NOW)!);
  const upserts = calls.filter((c) => c.sql.startsWith('INSERT INTO error_counts'));
  assert.equal(upserts.length, 1);
  assert.ok(upserts[0].sql.includes('ON CONFLICT (instance_id, day, fingerprint, version) DO UPDATE'));
  assert.deepEqual(upserts[0].params.slice(0, 4), [INSTANCE, '2026-11-10', '0123456789abcdef', '1.20.0']);
});

test('nothing is forwarded without BUGSINK_TELEMETRY_DSN', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = '';
  const calls = mockDb(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  assert.deepEqual(await forwardInstant(validateErrorBatch(batch, NOW)!, NOW), { forwarded: 0, failed: 0 });
  assert.equal(calls.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('an error is forwarded the first time any instance reports it that day, without the instance id', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = DSN;
  const second = { ...error, fingerprint: 'fedcba9876543210' };
  // The second one was already forwarded today (by this or another instance).
  const calls = mockDb(t, (params) => params[1] !== 'fedcba9876543210');
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(null, { status: 200 });
  });
  const clean = validateErrorBatch({ ...batch, errors: [error, second] }, NOW)!;
  assert.deepEqual(await forwardInstant(clean, NOW), { forwarded: 1, failed: 0 });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].includes(INSTANCE), false);
  const event = JSON.parse(bodies[0].trim().split('\n')[2]);
  assert.deepEqual(event.fingerprint, ['bulwark-telemetry', '0123456789abcdef', '1.20.0']);
  assert.equal(event.tags.mode, 'instant');
  assert.equal(event.timestamp, NOW / 1000);
  assert.equal(calls.filter((c) => c.sql.startsWith('INSERT INTO error_instant_forwards')).length, 2);
});

test('a failed send gives the claim back, so a later report tries again', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = DSN;
  const calls = mockDb(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(await forwardInstant(validateErrorBatch(batch, NOW)!, NOW), { forwarded: 0, failed: 1 });
  assert.equal(calls.filter((c) => c.sql.startsWith('DELETE FROM error_instant_forwards')).length, 1);
});

test('at most 30 errors a minute go to Bugsink; the rest wait for the daily summary', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = DSN;
  mockDb(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const many = Array.from({ length: 50 }, (_, i) => ({ ...error, fingerprint: i.toString(16).padStart(16, '0') }));
  const clean = validateErrorBatch({ ...batch, errors: many }, NOW)!;
  assert.equal((await forwardInstant(clean, NOW)).forwarded, 30);
  assert.equal((await forwardInstant(clean, NOW + 10_000)).forwarded, 0);
  assert.equal(fetchMock.mock.callCount(), 30);
  assert.equal((await forwardInstant(clean, NOW + 61_000)).forwarded, 30);
});

test('an instance can post once every 30 seconds', () => {
  const limiter = new InstanceLimiter(30_000);
  assert.equal(limiter.allow(INSTANCE, NOW), true);
  assert.equal(limiter.allow(INSTANCE, NOW + 10_000), false);
  assert.equal(limiter.allow('a0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', NOW + 10_000), true);
  assert.equal(limiter.allow(INSTANCE, NOW + 30_000), true);
});

test('the limiter keeps at most its bound of ids, dropping the oldest, and keeps answering', () => {
  const limiter = new InstanceLimiter(30_000, 3);
  const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  for (let n = 0; n < 1000; n++) assert.equal(limiter.allow(id(n), NOW + n), true);
  assert.equal(limiter.size, 3);
  // The three let through last are still limited; the oldest of all was dropped.
  assert.equal(limiter.allow(id(999), NOW + 1000), false);
  assert.equal(limiter.allow(id(997), NOW + 1000), false);
  assert.equal(limiter.allow(id(0), NOW + 1000), true);
  assert.equal(limiter.size, 3);
});

test('the limiter forgets ids on its timer once their interval is over, not on a request', () => {
  const limiter = new InstanceLimiter(30_000);
  limiter.allow(INSTANCE, NOW);
  limiter.allow('a0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', NOW + 20_000);
  // A request walks nothing: both ids are still held.
  limiter.allow('b0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', NOW + 40_000);
  assert.equal(limiter.size, 3);
  limiter.prune(NOW + 40_000);
  assert.equal(limiter.size, 2);
  limiter.prune(NOW + 80_000);
  assert.equal(limiter.size, 0);
});

test('instant forwards count against the day\'s 100 groups for Bugsink', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = DSN;
  let sentToday = 99;
  const calls: string[] = [];
  const record = async (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push(sql);
    if (sql.includes(' AS sent')) return { rows: [{ sent: String(sentToday) }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO error_instant_forwards')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO error_forward_senders')) return { rows: [{ instance_id: INSTANCE }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', record);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const two = [error, { ...error, fingerprint: 'fedcba9876543210' }];
  assert.equal((await forwardInstant(validateErrorBatch({ ...batch, errors: two }, NOW)!, NOW)).forwarded, 1);
  sentToday = 100;
  calls.length = 0;
  assert.equal((await forwardInstant(validateErrorBatch({ ...batch, errors: two }, NOW)!, NOW + 61_000)).forwarded, 0);
  assert.equal(calls.some((c) => c.startsWith('INSERT INTO error_instant_forwards')), false);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('one instance\'s instant batches bring in at most its share of the day\'s forwards', async (t) => {
  resetInstantForTests();
  env.bugsinkTelemetryDsn = DSN;
  let charged = 0;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const record = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (sql.includes(' AS sent')) return { rows: [{ sent: '0' }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO error_instant_forwards')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO error_forward_senders')) {
      if (charged >= (params[2] as number)) return { rows: [], rowCount: 0 };
      charged++;
      return { rows: [{ instance_id: INSTANCE }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', record);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const twenty = Array.from({ length: 20 }, (_, i) => ({ ...error, fingerprint: i.toString(16).padStart(16, '0') }));
  assert.equal((await forwardInstant(validateErrorBatch({ ...batch, errors: twenty }, NOW)!, NOW)).forwarded, 10);
  assert.equal(fetchMock.mock.callCount(), 10);
  // The claim of the one it couldn't charge is given back, for another instance or the daily forward.
  assert.equal(calls.filter((c) => c.sql.startsWith('DELETE FROM error_instant_forwards')).length, 1);
  assert.deepEqual(calls.find((c) => c.sql.includes('INSERT INTO error_forward_senders'))!.params[1], [INSTANCE]);
});
