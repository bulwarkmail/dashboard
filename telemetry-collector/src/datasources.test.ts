// Every Grafana user who may look at a dashboard may also send any SQL to its data source
// (POST /api/ds/query). So a data source must log in as a role that can only read.
// postgres/test/effective-privileges.sh checks what the roles may really do; this reads the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** The Postgres data sources of datasources.yml: name, user, database. */
function postgresSources(): Array<{ name: string; user: string; database: string }> {
  const out: Array<{ name: string; user: string; database: string }> = [];
  for (const block of read('grafana/provisioning/datasources/datasources.yml').split(/\n\s*- name:/).slice(1)) {
    if (!/\n\s*type:\s*postgres\b/.test(block)) continue;
    out.push({
      name: block.split('\n')[0].trim(),
      user: block.match(/\n\s*user:\s*(\S+)/)?.[1] ?? '',
      database: block.match(/\n\s*database:\s*(\S+)/)?.[1] ?? '',
    });
  }
  return out;
}

/** database -> owner, from postgres/init.sql. */
function owners(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of read('postgres/init.sql').matchAll(/CREATE DATABASE\s+(\w+)\s+OWNER\s+(\w+)/gi)) map.set(m[1], m[2]);
  return map;
}

/**
 * The SQL that sets up the roles, without comments: init.sql creates them in a new data
 * directory, grafana-read-only.sql gives them their rights there and on every deploy.
 */
function roleSql(): string {
  return ['postgres/init.sql', 'postgres/grafana-read-only.sql']
    .map((file) => read(file).split('\n').map((line) => line.replace(/--.*$/, '')).join('\n'))
    .join('\n');
}

/** Each GRANT naming `role` after TO: the privileges, or `role:<name>` for a membership. */
function grantsTo(role: string): string[] {
  const out: string[] = [];
  for (const statement of roleSql().split(/;|\\gexec/)) {
    for (const m of statement.matchAll(/\bGRANT\s+([\s\S]+?)\s+TO\s+(\w+)/gi)) {
      if (m[2] !== role) continue;
      const on = /^([\s\S]+?)\s+ON\s+/i.exec(m[1]);
      if (!on) out.push(`role:${m[1].trim()}`);
      else out.push(...on[1].split(',').map((p) => p.trim().toUpperCase()));
    }
  }
  return out;
}

test('there are Postgres data sources to check', () => {
  assert.ok(postgresSources().length >= 3);
  assert.ok(owners().size >= 3);
});

for (const source of postgresSources()) {
  test(`${source.name} does not log in as the owner of its database`, () => {
    assert.ok(source.user, 'no user');
    assert.notEqual(source.user, owners().get(source.database), `Grafana queries ${source.database} as its owner ${source.user}: a Viewer can change and drop every table`);
  });

  test(`${source.name} logs in as a role the repo's SQL only lets read`, () => {
    const sql = roleSql();
    // The role exists, gets SELECT and nothing that writes, and joins no other role.
    assert.match(read('postgres/init.sql'), new RegExp(`CREATE (USER|ROLE)\\s+${source.user}\\b`, 'i'), `init.sql creates no role ${source.user}`);
    assert.match(sql, new RegExp(`GRANT\\s+SELECT\\b[^;]*\\bTO\\s+${source.user}\\b`, 'i'), `${source.user} is granted no SELECT`);
    const grants = grantsTo(source.user);
    for (const privilege of grants) {
      assert.ok(['SELECT', 'USAGE', 'CONNECT'].includes(privilege), `${source.user} is granted ${privilege}`);
    }
  });
}
