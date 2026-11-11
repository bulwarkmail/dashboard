// The tests run in order and share the registry's state: the first one sees a server that has
// loaded nothing yet. Releases are passed in, and fetch fails, so nothing reaches GitHub.
import { before, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { lookup, nextOverrides, parseOverrides, refresh, snapshot, type GithubRelease } from './registry.js';

const RELEASES: GithubRelease[] = ['1.0.0', '1.4.9', '1.4.10', '1.5.0'].map((v) => ({
  tag_name: `v${v}`,
  name: `v${v}`,
  html_url: `https://example.org/releases/v${v}`,
  published_at: '2026-01-01T00:00:00Z',
  draft: false,
  prerelease: false,
}));
const releases = async () => RELEASES;

const ADVISORY = 'GHSA-4356-876g-rfmh, GHSA-47pm-883h-885r';
const VALID = JSON.stringify({
  minimumSupported: '1.1.0',
  severities: { '1.4.10': { severity: 'security', advisory: ADVISORY } },
});

// Each is refused as a whole. null stands for a missing file.
const BROKEN: Array<[string, string | null]> = [
  ['a missing file', null],
  ['text that is no JSON', '{"minimumSupported": "1.1.0",'],
  ['an empty file', ''],
  ['a JSON array', '[]'],
  ['JSON null', 'null'],
  ['a JSON string', '"1.1.0"'],
  ['an unknown severity', JSON.stringify({ severities: { '1.4.10': { severity: 'critical', advisory: ADVISORY } } })],
  ['an entry without severity', JSON.stringify({ severities: { '1.4.10': { advisory: ADVISORY } } })],
  ['an advisory that is no GHSA id', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: 'CVE-2026-0001' } } })],
  ['an advisory that is a number', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: 1 } } })],
  ['a minimumSupported that is no version', JSON.stringify({ minimumSupported: 'one', severities: {} })],
  ['severities as a list', JSON.stringify({ severities: [] })],
  ['an entry key that is no version', JSON.stringify({ severities: { '1.4.x': { severity: 'security' } } })],
];

before(() => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
});

/** Captures the messages logged as errors. */
function errors(t: TestContext): string[] {
  const seen: string[] = [];
  t.mock.method(log, 'error', (msg: string) => { seen.push(msg); });
  return seen;
}

test('at start, a missing, unreadable or broken file stops the server and the log says which', async (t) => {
  const seen = errors(t);
  const unreadable = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  await assert.rejects(refresh({ releases, overridesText: () => null }), /missing/);
  await assert.rejects(refresh({ releases, overridesText: () => '{' }), /invalid/);
  await assert.rejects(refresh({ releases, overridesText: unreadable }), /unreadable/);
  assert.deepEqual(seen, ['overrides.missing', 'overrides.invalid', 'overrides.unreadable']);
});

test('every broken variant is refused at start and keeps the overrides loaded before', (t) => {
  errors(t);
  const previous = parseOverrides(VALID);
  for (const [what, text] of BROKEN) {
    assert.throws(() => nextOverrides(text, null), `${what} was taken`);
    assert.equal(nextOverrides(text, previous), previous, `${what} replaced the overrides loaded before`);
  }
});

test('while the file is broken, an old version gets the answer it got before', async (t) => {
  const seen = errors(t);
  await refresh({ releases, overridesText: () => VALID });
  assert.deepEqual(seen, []);
  assert.equal(lookup('1.0.0').severity, 'deprecated');
  assert.equal(lookup('1.4.9').severity, 'security');
  assert.equal(lookup('1.4.9').advisory, ADVISORY);
  assert.equal(snapshot().minimumSupported, '1.1.0');

  const unreadable = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  const reads: Array<[string, () => string | null]> = [
    ...BROKEN.map(([what, text]): [string, () => string | null] => [what, () => text]),
    ['an unreadable file', unreadable],
  ];
  for (const [what, read] of reads) {
    await refresh({ releases, overridesText: read });
    assert.equal(lookup('1.0.0').severity, 'deprecated', `${what}: a version below minimumSupported is no longer deprecated`);
    assert.equal(lookup('1.4.9').severity, 'security', `${what}: the security flag is gone`);
    assert.equal(lookup('1.4.9').advisory, ADVISORY, `${what}: the advisory is gone`);
    assert.equal(snapshot().minimumSupported, '1.1.0', `${what}: minimumSupported is gone`);
  }
  assert.equal(seen.length, reads.length, 'a broken file was not logged');
});

test('a file that is valid again after a broken refresh is taken', async (t) => {
  errors(t);
  await refresh({ releases, overridesText: () => '{' });
  const fixed = JSON.stringify({
    minimumSupported: '1.4.9',
    severities: { '1.5.0': { severity: 'security', advisory: 'GHSA-m7j8-f5q4-vj7x' } },
  });
  await refresh({ releases, overridesText: () => fixed });
  assert.equal(snapshot().minimumSupported, '1.4.9');
  assert.equal(lookup('1.4.0').severity, 'deprecated');
  assert.equal(lookup('1.4.9').severity, 'security');
  assert.equal(lookup('1.4.9').advisory, 'GHSA-m7j8-f5q4-vj7x');
});

test('the shipped overrides.json is valid and is found next to the package', async (t) => {
  const seen = errors(t);
  const file = fileURLToPath(new URL('../overrides.json', import.meta.url));
  const shipped = parseOverrides(fs.readFileSync(file, 'utf8'));
  assert.ok(shipped.severities.size > 0);
  await refresh({ releases });
  assert.deepEqual(seen, [], 'overrides.json was not read');
  assert.equal(snapshot().minimumSupported, shipped.minimumSupported);
});
