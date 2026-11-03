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
