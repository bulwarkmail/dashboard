// The version server's refresh intervals: a value that is no positive number a timer holds gives the
// default, with one log line naming the setting. env.ts reads the environment once, so each case loads
// it in a process of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = {
  VERSION_SERVER_REFRESH_MS: { key: 'refreshIntervalMs', fallback: 60 * 60 * 1000 },
  VERSION_SERVER_ANDROID_REFRESH_MS: { key: 'androidRefreshIntervalMs', fallback: 10 * 60 * 1000 },
} as const;
const MAX_TIMER_MS = 2 ** 31 - 1;

function load(vars: Record<string, string>): { values: Record<string, number>; lines: Array<Record<string, unknown>> } {
  const script = `const { env } = await import(${JSON.stringify(pathToFileURL(path.join(here, 'env.ts')).href)});
    console.log('VALUES ' + JSON.stringify(env));`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.dirname(here),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...vars },
  });
  const lines = out.split('\n').filter(Boolean);
  const values = JSON.parse(lines.find((l) => l.startsWith('VALUES '))!.slice(7)) as Record<string, number>;
  return { values, lines: lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test('an interval that is no positive number a timer holds gives the default, with one log line', () => {
  for (const value of ['0', '-1', '', ' ', 'abc', 'NaN', 'Infinity', String(MAX_TIMER_MS + 1), String(30 * 24 * 60 * 60 * 1000)]) {
    const { values, lines } = load(Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, value])));
    for (const [name, s] of Object.entries(SETTINGS)) {
      assert.equal(values[s.key], s.fallback, `${name}=${JSON.stringify(value)} was taken as ${values[s.key]}`);
      const said = lines.filter((l) => l.msg === 'setting_ignored' && l.setting === name);
      assert.equal(said.length, 1, `${name}=${JSON.stringify(value)}: ${said.length} log lines`);
      assert.equal(said[0].used, s.fallback);
    }
  }
});

test('a positive interval a timer holds is taken, without a log line', () => {
  for (const value of ['1', '90000', String(MAX_TIMER_MS)]) {
    const { values, lines } = load(Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, value])));
    for (const s of Object.values(SETTINGS)) assert.equal(values[s.key], Number(value));
    assert.deepEqual(lines, []);
  }
});
