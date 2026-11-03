import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, validateErrorBatch } from './validate.js';

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

test('keeps the desktop platform, and still turns an unknown one into unknown', () => {
  assert.equal(validate({ ...base, platform: 'desktop', build: 'desktop.instance.beta' })?.platform, 'desktop');
  assert.equal(validate({ ...base, platform: 'desktop', build: 'desktop.instance.beta' })?.build, 'desktop.instance.beta');
  assert.equal(validate({ ...base, platform: 'toaster' })?.platform, 'unknown');
});

test('takes a main-process frame of the desktop app in an error batch, and no path on a disk', () => {
  const batch = (path: string) => ({
    schema: '1',
    instance_id: base.instance_id,
    day: new Date().toISOString().slice(0, 10),
    errors: [{ name: 'TypeError', fingerprint: '0123456789abcdef', frames: [{ path, line: 1, col: 2, debug_id: null }], version: '0.3.0+desktop', count: '1', days: 1 }],
  });
  assert.ok(validateErrorBatch(batch('/desktop/main.mjs')));
  assert.equal(validateErrorBatch(batch('C:/Users/linus/app.asar/dist/main.mjs')), null);
  assert.equal(validateErrorBatch(batch('/home/linus/main.mjs')), null);
});

test('takes a prerelease with build metadata, as a beta of the desktop app reports', () => {
  assert.equal(validate({ ...base, version: '0.3.0-beta.1+desktop' })?.version, '0.3.0-beta.1+desktop');
  assert.equal(validate({ ...base, version: '1.20.0+desktop' })?.version, '1.20.0+desktop');
  assert.equal(validate({ ...base, version: '1.20.0-rc.2' })?.version, '1.20.0-rc.2');
  assert.equal(validate({ ...base, version: '1.20.0+a+b' }), null);
  assert.equal(validate({ ...base, version: '1.20.0-beta/../x' }), null);
});

test('takes that version on an error in a batch too', () => {
  const clean = validateErrorBatch({
    schema: '1',
    instance_id: base.instance_id,
    day: new Date().toISOString().slice(0, 10),
    errors: [{ name: 'TypeError', fingerprint: '0123456789abcdef', frames: [], version: '0.3.0-beta.1+desktop', count: '1', days: 1 }],
  });
  assert.equal(clean?.errors[0].version, '0.3.0-beta.1+desktop');
});
