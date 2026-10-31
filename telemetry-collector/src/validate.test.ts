import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from './validate.js';

const base = {
  schema: '1',
  instance_id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
  version: '1.20.0',
};

test('keeps only the day of the heartbeat timestamp', () => {
  const clean = validate({ ...base, ts: '2026-04-27T17:42:13.456Z' });
  assert.ok(clean);
  assert.equal(clean.ts, '2026-04-27T00:00:00.000Z');
});

test('rounds a timestamp with an offset to its UTC day', () => {
  const clean = validate({ ...base, ts: '2026-04-27T23:30:00-02:00' });
  assert.ok(clean);
  assert.equal(clean.ts, '2026-04-28T00:00:00.000Z');
});

test('falls back to today, without the time, when ts is missing', () => {
  const clean = validate(base);
  assert.ok(clean);
  assert.match(clean.ts, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(clean.ts.slice(0, 10), new Date().toISOString().slice(0, 10));
});
