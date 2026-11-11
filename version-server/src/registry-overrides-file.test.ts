// The overrides file as it is on disk, a key named twice, what /health holds, and the flag while GitHub
// can't be reached. Releases are passed in and fetch fails, so nothing reaches GitHub. The tests share
// the registry's state and run in order: the first one sees a server that has loaded nothing yet.
import { before, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { lookup, nextOverrides, parseOverrides, refresh, snapshot, type GithubRelease } from './registry.js';

const RELEASES: GithubRelease[] = ['0.9.0', '1.0.0', '1.4.9', '1.4.10', '1.4.11', '1.5.0', '1.9.0', '1.9.2', '1.10.0', '1.16.0', '1.17.0'].map((v) => ({
  tag_name: `v${v}`, name: `v${v}`, html_url: `https://example.org/releases/v${v}`,
  published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false,
}));
const releases = async () => RELEASES;
const down = async (): Promise<GithubRelease[]> => { throw new Error('GitHub releases HTTP 503'); };
const A = 'GHSA-4356-876g-rfmh';
const B = 'GHSA-r2r7-pvh6-mvj5';
const shipped = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'overrides.json');

before(() => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
});

function quiet(t: TestContext): Array<{ msg: string; fields: unknown }> {
  const seen: Array<{ msg: string; fields: unknown }> = [];
  for (const level of ['info', 'warn', 'error'] as const) t.mock.method(log, level, (msg: string, fields?: unknown) => { seen.push({ msg, fields }); });
  return seen;
}

test('started while GitHub can\'t be reached, /health says the file\'s flags are not in use yet', async (t) => {
  quiet(t);
  const first = JSON.stringify({ minimumSupported: '1.0.0', severities: { '1.4.10': { severity: 'security', advisory: A } } });
  await refresh({ releases: down, overridesText: () => first });
  assert.equal(snapshot().count, 0);
  assert.equal(snapshot().overridesStale, true, 'no flag is in use, and /health said they were');
  assert.equal(snapshot().overridesProblem, 'releases-unavailable');
  await refresh({ releases, overridesText: () => first });
  assert.equal(snapshot().overridesStale, false);
  assert.equal(snapshot().overridesProblem, null);
});

test('the shipped overrides.json is taken as it is on disk, with either line ending and with or without a last newline', async (t) => {
  const seen = quiet(t);
  const bytes = fs.readFileSync(shipped);
  const text = bytes.toString('utf8');
  const lf = text.replace(/\r\n/g, '\n');
  const variants: Array<[string, string]> = [
    ['as on disk', text], ['LF', lf], ['CRLF', lf.replace(/\n/g, '\r\n')], ['no last newline', lf.replace(/\n+$/, '')],
    ['two last newlines', `${lf}\n`], ['tabs', lf.replace(/^ {2}/gm, '\t')], ['one line', JSON.stringify(JSON.parse(lf))],
  ];
  const expected = JSON.parse(lf) as { minimumSupported: string; severities: Record<string, { severity: string; advisory?: string }> };
  for (const [what, variant] of variants) {
    const parsed = parseOverrides(variant);
    assert.equal(parsed.minimumSupported, expected.minimumSupported, what);
    assert.deepEqual([...parsed.severities.keys()], Object.keys(expected.severities), what);
    for (const [version, entry] of Object.entries(expected.severities)) {
      assert.deepEqual(parsed.severities.get(version), { severity: entry.severity, advisory: entry.advisory ?? null }, `${what}: ${version}`);
    }
  }
  // And through a refresh: every flag of the file shows in the answers.
  await refresh({ releases, overridesText: () => text });
  assert.equal(snapshot().overridesStale, false);
  assert.equal(snapshot().minimumSupported, '1.0.0');
  assert.equal(lookup('0.9.0').severity, 'deprecated');
  assert.equal(lookup('1.4.9').severity, 'security');
  assert.equal(lookup('1.15.0').advisory, B);
  assert.deepEqual(seen.filter((s) => s.msg.startsWith('overrides.')), []);
});

test('a key named twice does not silently replace the flags written first', async (t) => {
  quiet(t);
  const good = JSON.stringify({ minimumSupported: '1.0.0', severities: { '1.4.10': { severity: 'security', advisory: A }, '1.16.0': { severity: 'security', advisory: B } } });
  await refresh({ releases, overridesText: () => good });
  assert.equal(lookup('1.4.9').severity, 'security');

  const twice: Array<[string, string]> = [
    // A second, empty "severities" at the end of the file.
    ['severities twice, the second empty', `{"minimumSupported":"1.0.0","severities":{"1.4.10":{"severity":"security","advisory":"${A}"},"1.16.0":{"severity":"security","advisory":"${B}"}},"severities":{}}`],
    // A block copied to add 1.17.0 where the version was not changed: the copy replaces the 1.16.0 entry.
    ['a version twice', `{"minimumSupported":"1.0.0","severities":{"1.4.10":{"severity":"security","advisory":"${A}"},"1.16.0":{"severity":"security","advisory":"${B}"},"1.16.0":{"severity":"normal"}}}`],
    ['severity twice in an entry', `{"minimumSupported":"1.0.0","severities":{"1.4.10":{"severity":"security","advisory":"${A}"},"1.16.0":{"severity":"security","severity":"normal","advisory":"${B}"}}}`],
    ['minimumSupported twice', `{"minimumSupported":"1.0.0","minimumSupported":"0.0.1","severities":{"1.4.10":{"severity":"security","advisory":"${A}"},"1.16.0":{"severity":"security","advisory":"${B}"}}}`],
    ['a key twice, once written with an escape', `{"minimumSupported":"1.0.0","severities":{"1.4.10":{"severity":"security","advisory":"${A}"}},"\\u0073everities":{}}`],
  ];
  const outcome: string[] = [];
  for (const [what, text] of twice) {
    assert.throws(() => parseOverrides(text), /key named twice/, `${what} was taken`);
    await refresh({ releases, overridesText: () => good });
    await refresh({ releases, overridesText: () => text });
    const health = snapshot();
    const lost: string[] = [];
    if (lookup('1.4.9').severity !== 'security') lost.push('the 1.4.10 flag');
    if (lookup('1.15.0').severity !== 'security') lost.push('the 1.16.0 flag');
    if (lookup('0.9.0').severity !== 'deprecated') lost.push('minimumSupported');
    outcome.push(`${what}: ${health.overridesStale ? 'refused' : `taken${lost.length ? `, lost ${lost.join(' and ')}` : ''}`}`);
  }
  // Either refused (the flags loaded before stay) or taken without losing a flag that is written in the file.
  assert.deepEqual(outcome.filter((o) => o.includes('lost')), []);
  // The same key in two different objects is no repetition.
  assert.equal(parseOverrides(good).severities.size, 2);
});

test('/health holds nothing of a broken file but which kind of problem it is', async (t) => {
  const seen = quiet(t);
  const good = JSON.stringify({ minimumSupported: '1.0.0', severities: { '1.4.10': { severity: 'security', advisory: A } } });
  const MARK = 'zq9marker';
  const broken: string[] = [
    JSON.stringify({ [`${MARK}key`]: 1 }),
    JSON.stringify({ minimumSupported: `${MARK}` }),
    JSON.stringify({ severities: { [MARK]: { severity: 'security' } } }),
    JSON.stringify({ severities: { '1.4.10': { severity: MARK } } }),
    JSON.stringify({ severities: { '1.4.10': { severity: 'security', advisory: MARK } } }),
    JSON.stringify({ severities: { '1.4.10': { severity: 'security', [MARK]: 1 } } }),
    `{"${MARK}`, MARK, `[${JSON.stringify(MARK)}]`, JSON.stringify(MARK),
    JSON.stringify({ ['x'.repeat(5000) + MARK]: 1 }),
  ];
  await refresh({ releases, overridesText: () => good });
  const keys = Object.keys(snapshot()).sort();
  for (const text of broken) {
    await refresh({ releases, overridesText: () => text });
    const health = snapshot();
    assert.deepEqual(Object.keys(health).sort(), keys);
    assert.equal(health.overridesStale, true);
    assert.equal(health.overridesProblem, 'invalid');
    assert.ok(!JSON.stringify(health).includes(MARK), `the health output holds the file's content: ${JSON.stringify(health)}`);
    assert.equal(health.minimumSupported, '1.0.0');
  }
  // The log may name the key, cut short.
  const longest = Math.max(...seen.filter((s) => s.msg === 'overrides.invalid').map((s) => JSON.stringify(s.fields).length));
  assert.ok(longest < 600, `an overrides.invalid log line has ${longest} characters`);
});

test('while GitHub can\'t be reached, /health does not say the file\'s flags are in use when the answers still come from the old ones', async (t) => {
  quiet(t);
  const first = JSON.stringify({ minimumSupported: '1.0.0', severities: { '1.4.10': { severity: 'security', advisory: A } } });
  const second = JSON.stringify({ minimumSupported: '1.4.10', severities: { '1.16.0': { severity: 'security', advisory: B } } });
  await refresh({ releases, overridesText: () => first });
  await refresh({ releases, overridesText: () => '{ broken' });
  assert.equal(snapshot().overridesStale, true);

  // The file is repaired with new content; this refresh does not reach GitHub.
  await refresh({ releases: down, overridesText: () => second });
  const health = snapshot();
  const answersAreNew = lookup('1.4.9').severity === 'deprecated' && lookup('1.15.0').advisory === B && health.minimumSupported === '1.4.10';
  assert.ok(health.overridesStale || answersAreNew, 'overridesStale is false while the answers still use the overrides from before the repair');
  assert.equal(health.overridesProblem, 'releases-unavailable');
  // The next refresh that reaches GitHub takes the new content and clears the flag.
  await refresh({ releases, overridesText: () => second });
  assert.equal(snapshot().overridesStale, false);
  assert.equal(snapshot().minimumSupported, '1.4.10');
});

test('a broken file while GitHub is down keeps the flags and is flagged; nothing loaded before means no start', async (t) => {
  quiet(t);
  const first = JSON.stringify({ minimumSupported: '1.0.0', severities: { '1.4.10': { severity: 'security', advisory: A } } });
  await refresh({ releases, overridesText: () => first });
  await refresh({ releases: down, overridesText: () => '{ broken' });
  assert.equal(snapshot().overridesStale, true);
  assert.equal(snapshot().overridesProblem, 'invalid');
  assert.equal(lookup('1.4.9').severity, 'security');
  // nextOverrides() with nothing loaded before is the start: it throws whatever GitHub does.
  assert.throws(() => nextOverrides('{ broken', null));
});
