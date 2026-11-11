// Needs a real Postgres, like rollup-late-heartbeats.test.ts (same switch and setup; skipped
// unless ROLLUP_TEST_PG=1): the question is what the public panel's own SQL shows for the rows the
// collector stores, and a mocked pool can't answer that.
//
// Run this file on its own: the Postgres-backed test files share one database and empty its tables.
//
// The public statistics page shows a version table that anyone can post into: every heartbeat is
// anonymous. A version that a single instance id reports must not be able to push the versions
// most instances run off that table, and text that one caller invents must not appear on it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.POSTGRES_TELEMETRY_PASSWORD ??= 'test';

const { pool, migrate } = await import('./db.js');
const { storeHeartbeat } = await import('./heartbeat.js');
const { validate } = await import('./validate.js');

const withPg = process.env.ROLLUP_TEST_PG === '1';

interface Panel { title: string; targets?: { rawSql?: string }[] }
function versionPanelSql(): string {
  const file = new URL('../../grafana/dashboards/public-adoption.json', import.meta.url);
  const panel = (JSON.parse(readFileSync(file, 'utf8')) as { panels: Panel[] }).panels.find((p) => p.title.startsWith('Version distribution'));
  assert.ok(panel?.targets?.[0]?.rawSql, 'the public dashboard has no version panel');
  return panel.targets[0].rawSql;
}

function heartbeat(version: string, id = crypto.randomUUID()): Record<string, unknown> {
  return {
    schema: '1', instance_id: id, ts: new Date().toISOString(), version, build: 'release', platform: 'docker',
    node_version: '24.1.0', os_family: 'linux', stalwart_version: '0.16.27',
    features: { calendar: true, contacts: true, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
    counts: { accounts: '2-5', accounts_active_7d: '1', extensions_installed: 0, themes_installed: 0 },
    uptime_days: 3,
  };
}

/** Post a heartbeat the way the server does: validate, then store. A refused one stores nothing. */
async function post(body: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const clean = validate(body, now);
  if (clean) await storeHeartbeat(clean, now);
}

async function shown(): Promise<string[]> {
  const { rows } = await pool.query<{ version: string; instances: string | number }>(versionPanelSql());
  return rows.map((r) => r.version);
}

after(async () => {
  if (withPg) await pool.end();
});

test('with Postgres: invented versions from single ids neither replace the real ones on the public version table nor show up on it', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats');

  // What instances really run.
  for (let i = 0; i < 30; i++) await post(heartbeat('1.21.1'));
  for (let i = 0; i < 4; i++) await post(heartbeat('1.20.0'));
  for (let i = 0; i < 3; i++) await post(heartbeat('1.21.0-beta.2'));

  // One caller, 25 new ids, one invented version each: as many rows as the table has.
  const invented = Array.from({ length: 25 }, (_, i) => `9${String(99 - i).padStart(2, '0')}.0.0-INVENTED.TEXT.see.some-site.example`);
  for (const version of invented) await post(heartbeat(version));

  const table = await shown();
  assert.ok(table.includes('1.21.1'), `the version 30 instances run is not on the table: ${table.slice(0, 4).join(', ')} ...`);
  assert.ok(table.includes('1.20.0'), 'the version 4 instances run is not on the table');
  const leaked = table.filter((v) => invented.includes(v));
  assert.deepEqual(leaked, [], `${leaked.length} invented version strings, each from one id, are on the public table`);
});

test('with Postgres: release-shaped versions from new ids come after what installations known for days run', { skip: !withPg && 'set ROLLUP_TEST_PG=1 and point PG_PORT at a throwaway Postgres' }, async () => {
  await migrate();
  await pool.query('TRUNCATE heartbeats, instance_meta, new_instance_counts, pending_heartbeats');

  // Installations known for ten days.
  for (let i = 0; i < 30; i++) await post(heartbeat('1.21.1'));
  for (let i = 0; i < 4; i++) await post(heartbeat('1.20.0'));
  for (let i = 0; i < 3; i++) await post(heartbeat('1.21.0-beta.2'));
  await pool.query("UPDATE instance_meta SET first_seen = current_date - 10");

  // Today: 30 new ids, each with a high version of the right shape, and two new ids that share one.
  const single = Array.from({ length: 30 }, (_, i) => `${900 + i}.0.0`);
  for (const version of single) await post(heartbeat(version));
  for (let i = 0; i < 2; i++) await post(heartbeat('999.9.9'));

  const table = await shown();
  assert.deepEqual(table.slice(0, 3), ['1.21.1', '1.20.0', '1.21.0-beta.2'], `the real versions are not first: ${table.join(', ')}`);
  assert.deepEqual(table.filter((v) => single.includes(v)), [], 'a version only one new id reports is on the public table');
  // Two new installations with the same version are shown, after the known ones.
  assert.equal(table.indexOf('999.9.9'), 3);
});
