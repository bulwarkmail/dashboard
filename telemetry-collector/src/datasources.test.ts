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

/**
 * Each GRANT naming `role` (any place in the grantee list; PUBLIC is matched as `PUBLIC`): the
 * privileges, or `role:<name>` for a membership.
 */
function grantsTo(role: string): string[] {
  const out: string[] = [];
  for (const statement of roleSql().split(/;|\\gexec/)) {
    for (const m of statement.matchAll(/\bGRANT\s+([\s\S]+?)\s+TO\s+(\w+(?:\s*,\s*\w+)*)/gi)) {
      const grantees = m[2].split(',').map((g) => g.trim());
      if (!grantees.some((g) => (role === 'PUBLIC' ? g.toUpperCase() === 'PUBLIC' : g === role))) continue;
      const on = /^([\s\S]+?)\s+ON\s+/i.exec(m[1]);
      if (!on) out.push(`role:${m[1].trim()}`);
      else out.push(...on[1].split(',').map((p) => p.trim().toUpperCase()));
    }
  }
  return out;
}

test('the repo\'s SQL grants nothing to PUBLIC', () => {
  assert.deepEqual(grantsTo('PUBLIC'), []);
});

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
    // Owns nothing and gets no attribute that writes or creates.
    assert.doesNotMatch(sql, new RegExp(`OWNER\\s+TO\\s+${source.user}\\b`, 'i'));
    for (const m of sql.matchAll(new RegExp(`ALTER\\s+ROLE\\s+${source.user}\\b([^;]*)`, 'gi'))) {
      assert.doesNotMatch(m[1], /(?<!NO)(SUPERUSER|CREATEROLE|CREATEDB|REPLICATION|BYPASSRLS)\b/i, `${source.user} gets ${m[1].trim()}`);
    }
  });

  // Postgres lets a role change its own settings and password: each run of the grants file puts
  // them back, and gives the role a temp_file_limit, which only a superuser can change.
  test(`${source.name}'s login is reset on every run and has a limit it can't lift`, () => {
    const file = read('postgres/grafana-read-only.sql');
    assert.match(file, new RegExp(`ALTER ROLE ${source.user}\\s+RESET ALL;`));
    assert.match(file, /format\('ALTER ROLE %I IN DATABASE %I RESET ALL'/);
    assert.match(file, new RegExp(`ALTER ROLE ${source.user}\\s+SET temp_file_limit = '\\d+MB';`));
    assert.match(file, new RegExp(`ALTER ROLE ${source.user}\\s+WITH [^;]*PASSWORD :'`));
  });
}

test('a service cancels the read-only logins\' long statements, which their own timeout can\'t promise', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /query-watchdog:[\s\S]*?entrypoint: \["\/bin\/sh", "\/watchdog\/query-watchdog\.sh"\]/);
  const sql = read('postgres/watchdog/query-watchdog.sql');
  for (const source of postgresSources()) assert.ok(sql.includes(`'${source.user}'`), `the watchdog leaves ${source.user} alone`);
  assert.match(sql, /pg_cancel_backend\(pid\)/);
  assert.match(read('postgres/grafana-read-only.sql'), /GRANT pg_signal_backend, pg_read_all_stats TO grafana_query_watchdog;/);
});
