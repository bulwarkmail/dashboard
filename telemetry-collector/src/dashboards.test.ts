import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The panels about servers count servers: a desktop app is one user, and one in
// instance mode has every feature false and no accounts. The platform mix is where it shows.

interface Panel { id: number; title: string; targets?: { rawSql?: string }[] }

function panels(name: string): Panel[] {
  const file = new URL(`../../grafana/dashboards/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { panels: Panel[] }).panels;
}

const FILTER = "COALESCE(payload->>'build', '') NOT LIKE 'desktop.%'";

for (const [name, titles] of [
  ['public-adoption', ['Active instances (last 30 days)', 'Version distribution (latest snapshot per instance, last 7 days)']],
  ['self-hosted-adoption', ['Active instances (last 7d)', 'Active instances (last 30d)', 'Active instances per day', 'OS family (last 7d)', 'Account-count buckets (last 7d)', 'Version distribution (latest snapshot per instance, last 7d)', 'Feature adoption (% of active instances, last 7d)']],
] as const) {
  for (const title of titles) {
    test(`${name}: ${title} leaves desktop out`, () => {
      const panel = panels(name).find((p) => p.title === title);
      assert.ok(panel, 'no such panel');
      assert.ok(panel.targets?.every((t) => t.rawSql?.includes(FILTER)), panel.targets?.[0]?.rawSql);
    });
  }
}

test('the platform mix still shows desktop, with no filter', () => {
  for (const [name, title] of [['public-adoption', 'Platform mix (last 7 days)'], ['self-hosted-adoption', 'Platform mix (last 7d)']]) {
    const sql = panels(name).find((p) => p.title === title)?.targets?.[0]?.rawSql ?? '';
    assert.ok(sql.includes("AS desktop"), sql);
    assert.equal(sql.includes(FILTER), false);
  }
});

// Anyone can post a heartbeat with a new id. The public version table puts the versions that
// installations known for more than a day run first, and leaves out a version only one new
// installation reports, so versions that appeared today from new ids push no real one off it.
// public-version-panel.test.ts runs the panel against Postgres.
test('the public version table ranks by installations known for more than a day', () => {
  const sql = panels('public-adoption').find((p) => p.title.startsWith('Version distribution'))?.targets?.[0]?.rawSql ?? '';
  assert.match(sql, /count\(\*\) FILTER \(WHERE im\.first_seen < \(SELECT to_d FROM win\) - 1\) AS known/);
  assert.match(sql, /LEFT JOIN instance_meta im ON im\.instance_id = l\.instance_id/);
  assert.match(sql, /WHERE known > 0 OR instances >= 2 ORDER BY known DESC, instances DESC,/);
});

// Stored versions stay 90 days, also ones from before the collector bounded them: a panel casts
// only the leading N.N.N of at most 4 digits each (anything else becomes NULL) and sorts NULL last.
test('every panel that sorts by version copes with any stored version', () => {
  const safe = /string_to_array\(substring\((?:\w+\.)?version FROM '\^\\d\{1,4\}\\\.\\d\{1,4\}\\\.\\d\{1,4\}'\), '\.'\)::int\[\]/g;
  let casts = 0;
  for (const name of ['public-adoption', 'self-hosted-adoption', 'telemetry-errors']) {
    for (const panel of panels(name)) {
      for (const sql of (panel.targets ?? []).map((t) => t.rawSql ?? '')) {
        const all = sql.split('::int[]').length - 1;
        const guarded = [...sql.matchAll(safe)];
        casts += all;
        assert.equal(guarded.length, all, `${name}: ${panel.title} casts a version without the guard`);
        for (const m of guarded) {
          const rest = sql.slice((m.index ?? 0) + m[0].length);
          if (/^\s+DESC\b/.test(rest)) assert.match(rest, /^\s+DESC NULLS LAST\b/, `${name}: ${panel.title} sorts an unreadable version first`);
        }
      }
    }
  }
  assert.ok(casts >= 6);
});
