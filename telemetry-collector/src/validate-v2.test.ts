import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ERRORS, MAX_FRAMES, validate } from './validate.js';

const v1 = {
  schema: '1',
  instance_id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
  ts: '2026-11-10T08:12:00.000Z',
  version: '1.20.0',
  build: 'release',
  platform: 'docker',
  node_version: '24.1.0',
  os_family: 'linux',
  stalwart_version: null,
  features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
  counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
  uptime_days: 3,
};

const error = {
  name: 'TypeError',
  fingerprint: '0123456789abcdef',
  frames: [{ path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2' }],
  version: '1.20.0',
  count: '6-10',
  days: 2,
};

const v2 = { ...v1, schema: '2', errors: [error] };

test('schema 1 is accepted and stored exactly as before', () => {
  const clean = validate({ ...v1, extra: 'dropped' }, Date.parse('2026-11-10T08:12:01Z'));
  assert.ok(clean);
  assert.equal(clean.schema, '1');
  assert.equal('extra' in clean, false);
  assert.equal('errors' in clean, false);
  assert.equal(clean.ts, '2026-11-10T00:00:00.000Z');
});

test('schema 2 is accepted with its errors', () => {
  const clean = validate(v2);
  assert.ok(clean && clean.schema === '2');
  assert.deepEqual(clean.errors, [{ ...error, message: null }]);
  assert.equal(clean.counts.accounts, '2-5');
});

test('schema 2 keeps a fixed error code as message', () => {
  const clean = validate({ ...v2, errors: [{ ...error, name: 'JmapMethodError', message: 'Email/set: overQuota' }] });
  assert.ok(clean && clean.schema === '2');
  assert.equal(clean.errors[0].message, 'Email/set: overQuota');
});

test('schema 2 rejects unknown fields anywhere', () => {
  assert.equal(validate({ ...v2, hostname: 'mail.example.org' }), null);
  assert.equal(validate({ ...v2, features: { ...v1.features, secret: true } }), null);
  assert.equal(validate({ ...v2, counts: { ...v1.counts, users: 3 } }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, url: 'https://x' }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, frames: [{ ...error.frames[0], fn: 'x' }] }] }), null);
});

test('schema 2 rejects free text and paths outside the bundles', () => {
  assert.equal(validate({ ...v2, errors: [{ ...error, message: 'Merger plans for Acme' }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, name: 'Merger plans' }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, frames: [{ ...error.frames[0], path: 'https://mail.example.org/_next/static/chunks/1.js' }] }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, frames: [{ ...error.frames[0], path: '/home/alice/app.js' }] }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, fingerprint: 'not-hex' }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, count: '0' }] }), null);
  assert.equal(validate({ ...v2, errors: [{ ...error, days: 8 }] }), null);
});

test('schema 2 bounds the number of errors and frames', () => {
  const many = Array.from({ length: MAX_ERRORS + 1 }, (_, i) => ({ ...error, fingerprint: i.toString(16).padStart(16, '0') }));
  assert.equal(validate({ ...v2, errors: many }), null);
  assert.ok(validate({ ...v2, errors: many.slice(0, MAX_ERRORS) }));
  const frames = Array.from({ length: MAX_FRAMES + 1 }, () => error.frames[0]);
  assert.equal(validate({ ...v2, errors: [{ ...error, frames }] }), null);
  assert.equal(validate({ ...v2, errors: [error, error] }), null);
  assert.equal(validate({ ...v2, errors: 'none' }), null);
});

test('an unknown schema is rejected', () => {
  assert.equal(validate({ ...v1, schema: '3' }), null);
});
