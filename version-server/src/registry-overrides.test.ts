// Odd and misspelt overrides files, and what /health says about them. Releases are passed in and
// fetch fails, so nothing reaches GitHub.
import { before, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { log } from './log.js';
import { lookup, nextOverrides, parseOverrides, refresh, snapshot, type GithubRelease } from './registry.js';

const RELEASES: GithubRelease[] = ['1.0.0', '1.4.9', '1.4.10', '1.5.0'].map((v) => ({
  tag_name: `v${v}`, name: `v${v}`, html_url: `https://example.org/releases/v${v}`,
  published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false,
}));
const releases = async () => RELEASES;
const ADVISORY = 'GHSA-4356-876g-rfmh';
const VALID = JSON.stringify({
  _doc: 'a note for whoever edits the file',
  minimumSupported: '1.1.0',
  severities: { '1.4.10': { severity: 'security', advisory: ADVISORY } },
});

before(() => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
});

function errors(t: TestContext): string[] {
  const seen: string[] = [];
  t.mock.method(log, 'error', (msg: string) => { seen.push(msg); });
  return seen;
}

test('a misspelt key is refused like any other broken file, and keeps the flags loaded before', async (t) => {
  const seen = errors(t);
  const misspelt: Array<[string, string]> = [
    ['severites', JSON.stringify({ minimumSupported: '1.1.0', severites: { '1.4.10': { severity: 'security', advisory: ADVISORY } } })],
    ['Severities', JSON.stringify({ minimumSupported: '1.1.0', Severities: { '1.4.10': { severity: 'security', advisory: ADVISORY } } })],
    ['minimumSuported', JSON.stringify({ minimumSuported: '1.1.0', severities: { '1.4.10': { severity: 'security', advisory: ADVISORY } } })],
    ['minimum_supported', JSON.stringify({ minimum_supported: '1.1.0', severities: { '1.4.10': { severity: 'security', advisory: ADVISORY } } })],
    ['advisroy in an entry', JSON.stringify({ minimumSupported: '1.1.0', severities: { '1.4.10': { severity: 'security', advisroy: ADVISORY } } })],
  ];
  // The note the shipped file carries stays allowed.
  assert.doesNotThrow(() => parseOverrides(VALID));
  for (const [what, text] of misspelt) {
    assert.throws(() => parseOverrides(text), `a file with "${what}" was taken as valid`);
    assert.throws(() => nextOverrides(text, null), `a file with "${what}" lets the server start`);
  }
  // While the server runs: the answers stay as they were, and the log says so.
  await refresh({ releases, overridesText: () => VALID });
  for (const [what, text] of misspelt) {
    seen.length = 0;
    await refresh({ releases, overridesText: () => text });
    assert.equal(lookup('1.4.9').severity, 'security', `"${what}": the security flag is gone`);
    assert.equal(lookup('1.4.9').advisory, ADVISORY, `"${what}": the advisory is gone`);
    assert.equal(lookup('1.0.0').severity, 'deprecated', `"${what}": minimumSupported is gone`);
    assert.deepEqual(seen, ['overrides.invalid'], `"${what}" was not logged`);
  }
});

test('/health shows that the overrides in use are not the file\'s', async (t) => {
  errors(t);
  await refresh({ releases, overridesText: () => VALID });
  const good = JSON.stringify(snapshot());
  await refresh({ releases, overridesText: () => '{' });
  const stale = JSON.stringify({ ...snapshot(), fetchedAt: '' });
  assert.notEqual(stale, JSON.stringify({ ...JSON.parse(good), fetchedAt: '' }), 'the health output is the same with a broken file as with a good one');
});

test('the /health flag names the problem, holds none of the file\'s content, and clears with a good file', async (t) => {
  errors(t);
  const unreadable = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  await refresh({ releases, overridesText: () => VALID });
  assert.equal(snapshot().overridesStale, false);
  assert.equal(snapshot().overridesProblem, null);
  const broken = JSON.stringify({ minimumSupported: '1.1.0', severites_with_a_marker_xq7: {} });
  for (const [read, problem] of [[() => broken, 'invalid'], [() => null, 'missing'], [unreadable, 'unreadable']] as const) {
    await refresh({ releases, overridesText: read });
    const health = snapshot();
    assert.equal(health.overridesStale, true, `${problem}: not flagged`);
    assert.equal(health.overridesProblem, problem);
    assert.equal(health.minimumSupported, '1.1.0', `${problem}: the answers changed`);
    assert.ok(!JSON.stringify(health).includes('marker_xq7'), 'the health output holds the file\'s content');
  }
  await refresh({ releases, overridesText: () => VALID });
  assert.equal(snapshot().overridesStale, false, 'the flag stayed after the file was good again');
  assert.equal(snapshot().overridesProblem, null);
});

test('a valid file that drops a flag or the minimum on purpose takes effect', async (t) => {
  const seen = errors(t);
  await refresh({ releases, overridesText: () => VALID });
  assert.equal(lookup('1.4.9').severity, 'security');
  await refresh({ releases, overridesText: () => JSON.stringify({ minimumSupported: '1.1.0', severities: {} }) });
  assert.equal(lookup('1.4.9').severity, 'normal');
  assert.equal(lookup('1.0.0').severity, 'deprecated');
  await refresh({ releases, overridesText: () => '{}' });
  assert.equal(lookup('1.0.0').severity, 'normal');
  assert.equal(snapshot().minimumSupported, null);
  await refresh({ releases, overridesText: () => JSON.stringify({ severities: { '1.4.10': { severity: 'normal' }, '1.5.0': { severity: 'deprecated', advisory: null } } }) });
  assert.equal(lookup('1.4.9').severity, 'normal');
  assert.equal(snapshot().latest, '1.4.10');
  assert.deepEqual(seen, []);
});

test('wrong types, odd shapes and large files are refused or read, never half applied', (t) => {
  errors(t);
  const previous = parseOverrides(VALID);
  const refused: Array<[string, string]> = [
    ['a byte order mark', `﻿${VALID}`],
    ['minimumSupported null', JSON.stringify({ minimumSupported: null })],
    ['minimumSupported a number', JSON.stringify({ minimumSupported: 1 })],
    ['minimumSupported with two parts', JSON.stringify({ minimumSupported: '1.1' })],
    ['severities null', JSON.stringify({ severities: null })],
    ['severities a string', JSON.stringify({ severities: 'security' })],
    ['an entry that is a string', JSON.stringify({ severities: { '1.4.10': 'security' } })],
    ['an entry that is a list', JSON.stringify({ severities: { '1.4.10': ['security'] } })],
    ['an entry that is null', JSON.stringify({ severities: { '1.4.10': null } })],
    ['severity in capitals', JSON.stringify({ severities: { '1.4.10': { severity: 'Security' } } })],
    ['severity a list', JSON.stringify({ severities: { '1.4.10': { severity: ['security'] } } })],
    ['advisory a list', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: [ADVISORY] } } })],
    ['advisory empty', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: '' } } })],
    ['advisory with a trailing comma', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: `${ADVISORY},` } } })],
    ['advisory with a URL', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: `https://github.com/advisories/${ADVISORY}` } } })],
    ['advisory with markup', JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: `${ADVISORY}<script>` } } })],
    ['a key with a v', JSON.stringify({ severities: { 'v1.4.10': { severity: 'security' } } })],
    ['a key with a space', JSON.stringify({ severities: { ' 1.4.10': { severity: 'security' } } })],
    ['a key __proto__', '{"severities":{"__proto__":{"severity":"security"}}}'],
    ['one good and one bad entry', JSON.stringify({ severities: { '1.4.10': { severity: 'security' }, '1.5.0': { severity: 'bad' } } })],
    ['two documents', `${VALID}${VALID}`],
    ['a comment', `// flags\n${VALID}`],
    ['a file cut in the middle', VALID.slice(0, VALID.length - 20)],
  ];
  for (const [what, text] of refused) {
    assert.throws(() => nextOverrides(text, null), `${what} lets the server start`);
    assert.equal(nextOverrides(text, previous), previous, `${what} replaced the overrides loaded before`);
  }
  // 200 000 entries (about 8 MB) are read.
  const many: Record<string, { severity: string }> = {};
  for (let i = 0; i < 200000; i++) many[`9.${i}.0`] = { severity: 'deprecated' };
  assert.equal(parseOverrides(JSON.stringify({ severities: many })).severities.size, 200000);
});
