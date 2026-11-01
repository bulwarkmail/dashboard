import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const INSTANCE = 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b';
const group = {
  day: '2026-11-08',
  fingerprint: '0123456789abcdef',
  version: '1.20.0',
  name: 'TypeError',
  frames: [
    { path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2' },
    { path: '/_next/static/chunks/2.js', line: 4, col: 5, debug_id: null },
  ],
  message: null,
  instances: 3,
  buckets: ['1', '2-5', '6-10'],
  max_days: 4,
};

const { pool } = await import('./db.js');
const { env } = await import('./env.js');
const { buildForwardEvent, envelopeUrlFor, lastCompleteDay, runForward } = await import('./forward.js');

test('the event carries the custom fingerprint, release, frames with debug IDs and the day', () => {
  const event = buildForwardEvent(group);
  assert.deepEqual(event.fingerprint, ['bulwark-telemetry', '0123456789abcdef', '1.20.0']);
  assert.equal(event.release, '1.20.0');
  assert.equal(event.timestamp, Date.parse('2026-11-08T00:00:00Z') / 1000);
  assert.equal(event.platform, 'javascript');
  assert.deepEqual(event.debug_meta, { images: [{ type: 'sourcemap', code_file: '/_next/static/chunks/1.js', debug_id: 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2' }] });
  const frames = (event.exception as { values: Array<{ stacktrace: { frames: Array<{ abs_path: string }> } }> }).values[0].stacktrace.frames;
  assert.deepEqual(frames.map((f) => f.abs_path), ['/_next/static/chunks/2.js', '/_next/static/chunks/1.js']);
  assert.deepEqual(event.extra, { instances: 3, count_buckets: { '1': 1, '2-5': 1, '6-10': 1 }, count_at_least: 9, most_days_in_a_week: 4 });
});

test('the envelope URL comes from the DSN', () => {
  assert.deepEqual(envelopeUrlFor('https://77896adcc21c4520acff7ea093e42b2d@bugsink.example.org/2'),
    { url: 'https://bugsink.example.org/api/2/envelope/?sentry_key=77896adcc21c4520acff7ea093e42b2d&sentry_version=7' });
  assert.equal(envelopeUrlFor('not a dsn'), null);
});

test('a day is complete two days later', () => {
  assert.equal(lastCompleteDay(Date.parse('2026-11-10T01:00:00Z')), '2026-11-08');
});

test('nothing is forwarded without BUGSINK_TELEMETRY_DSN', async (t) => {
  env.bugsinkTelemetryDsn = '';
  const query = t.mock.method(pool, 'query', async () => ({ rows: [group] }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  assert.deepEqual(await runForward(), { forwarded: 0, failed: 0 });
  assert.equal(query.mock.callCount(), 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('each group is sent once, without the instance id, and marked as forwarded', async (t) => {
  env.bugsinkTelemetryDsn = 'https://77896adcc21c4520acff7ea093e42b2d@bugsink.example.org/2';
  const sql: string[] = [];
  t.mock.method(pool, 'query', async (text: string) => {
    sql.push(text.replace(/\s+/g, ' ').trim());
    return text.includes('FROM error_counts') ? { rows: [group, { ...group, fingerprint: 'fedcba9876543210' }] } : { rows: [] };
  });
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await runForward(Date.parse('2026-11-10T01:00:00Z')), { forwarded: 2, failed: 0 });
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.equal(body.includes(INSTANCE), false);
  assert.ok(sql[0].includes('NOT EXISTS (SELECT 1 FROM error_forwards'));
  assert.equal(sql.filter((s) => s.startsWith('INSERT INTO error_forwards')).length, 2);
});

test('a failed send leaves the group for the next run and never throws', async (t) => {
  env.bugsinkTelemetryDsn = 'https://77896adcc21c4520acff7ea093e42b2d@bugsink.example.org/2';
  const sql: string[] = [];
  t.mock.method(pool, 'query', async (text: string) => {
    sql.push(text);
    return text.includes('FROM error_counts') ? { rows: [group, group] } : { rows: [] };
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(await runForward(), { forwarded: 0, failed: 1 });
  assert.equal(sql.some((s) => s.includes('INSERT INTO error_forwards')), false);
});
