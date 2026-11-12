// The collector's limit and interval settings: a value that is no whole number in plain decimal digits
// from the setting's minimum to what the timer or counter holds gives the default, with one log line
// naming the setting. env.ts reads the environment once, so each case loads it in a process of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS = {
  COLLECTOR_SCAN_DEADLINE_MS: { key: 'scanDeadlineMs', fallback: 30 * 60 * 1000, min: 1000, max: 2 ** 31 - 1 },
  COLLECTOR_UNPACK_MAX_BYTES: { key: 'unpackMaxBytes', fallback: 1024 ** 3, min: 1024 ** 2, max: 8 * 1024 ** 3 },
  COLLECTOR_UNPACK_MAX_ENTRIES: { key: 'unpackMaxEntries', fallback: 200_000, min: 1, max: Number.MAX_SAFE_INTEGER },
  COLLECTOR_INTERVAL_FAST_MS: { key: 'fastIntervalMs', fallback: 15 * 60 * 1000, min: 60_000, max: 2 ** 31 - 1 },
  COLLECTOR_INTERVAL_SLOW_MS: { key: 'slowIntervalMs', fallback: 24 * 60 * 60 * 1000, min: 60_000, max: 2 ** 31 - 1 },
} as const;
type Name = keyof typeof SETTINGS;

/** Loads env.ts with `vars` set; returns the settings it took and the log lines it wrote. */
function load(vars: Partial<Record<Name, string>>): { values: Record<string, number>; lines: Array<Record<string, unknown>> } {
  const script = `const { env } = await import(${JSON.stringify(pathToFileURL(path.join(here, 'env.ts')).href)});
    console.log('VALUES ' + JSON.stringify(env));`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.dirname(here),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_TOKEN: 'ghp_FAKEenvFAKEenvFAKEenvFAKEenv000000', POSTGRES_DASHBOARD_PASSWORD: 'test', ...vars },
  });
  const lines = out.split('\n').filter(Boolean);
  const values = JSON.parse(lines.find((l) => l.startsWith('VALUES '))!.slice(7)) as Record<string, number>;
  return { values, lines: lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const all = (value: string) => Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, value])) as Record<Name, string>;

test('zero, a negative number, a blank value, text, NaN and Infinity give the default, each with one log line', () => {
  for (const value of ['0', '-1', '-5000', '', ' ', 'abc', '30m', 'NaN', 'Infinity', '-Infinity', '1e400',
    // Numbers JavaScript reads, but not whole numbers in plain decimal digits.
    '0.0001', '1.5', '0x10', '5e3', '+5000', '1_000', '5000.0', '2e9']) {
    const { values, lines } = load(all(value));
    for (const [name, s] of Object.entries(SETTINGS)) {
      assert.equal(values[s.key], s.fallback, `${name}=${JSON.stringify(value)} was taken as ${values[s.key]}`);
      const said = lines.filter((l) => l.msg === 'collector.setting_ignored' && l.setting === name);
      assert.equal(said.length, 1, `${name}=${JSON.stringify(value)}: ${said.length} log lines`);
      assert.equal(said[0].used, s.fallback);
    }
  }
});

test('a value above what the timer or the counter holds gives the default', () => {
  for (const [name, s] of Object.entries(SETTINGS)) {
    const over = s.max === Number.MAX_SAFE_INTEGER ? '9007199254740993' : String(s.max + 1);
    // 30 days for the timers, as an operator might write a long limit.
    const values = s.max === 2 ** 31 - 1 ? [over, String(30 * 24 * 60 * 60 * 1000)] : [over];
    for (const value of values) {
      const { values, lines } = load({ [name]: value });
      assert.equal(values[s.key], s.fallback, `${name}=${value} was taken as ${values[s.key]}`);
      assert.equal(lines.filter((l) => l.msg === 'collector.setting_ignored').length, 1);
    }
  }
});

test('a value just under the setting\'s minimum gives the default', () => {
  for (const [name, s] of Object.entries(SETTINGS)) {
    const { values, lines } = load({ [name]: String(s.min - 1) });
    assert.equal(values[s.key], s.fallback, `${name}=${s.min - 1} was taken as ${values[s.key]}`);
    assert.equal(lines.filter((l) => l.msg === 'collector.setting_ignored' && l.setting === name).length, 1);
  }
});

test('a whole number from the minimum to the maximum is taken, without a log line', () => {
  for (const [name, s] of Object.entries(SETTINGS)) {
    for (const value of [String(s.min), String(s.max), String(s.min + 1), ` ${s.min} `, `\t${s.max}\n`, `00${s.min}`]) {
      const { values, lines } = load({ [name]: value });
      assert.equal(values[s.key], Number(value.trim()), `${name}=${JSON.stringify(value)}`);
      assert.deepEqual(lines, []);
    }
  }
  // Unset: the defaults, quietly.
  const { values, lines } = load({});
  for (const s of Object.values(SETTINGS)) assert.equal(values[s.key], s.fallback);
  assert.deepEqual(lines, []);
});
