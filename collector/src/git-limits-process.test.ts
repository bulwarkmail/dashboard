// The limits of one repository's scan (time, bytes, entries), how they are set, and what is left when a
// scan is stopped. Every scan runs in a process of its own (scan-once.ts) with its own environment.
// Linux only, like git-scan.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanup, killAll, makeRemote, reposDir, row, running, scan, shim, tempFolders, tmp, unshim, work,
} from './scan-process.js';

const LIMIT = { COLLECTOR_SCAN_DEADLINE_MS: '2000' };
const STOPPED = 'stopped after 2 s, the time limit for one repository';
// The limit, the 5 s between SIGTERM and SIGKILL, and time for a loaded machine.
const SOON = 2000 + 5000 + 8000;

// A git that does `action` when its arguments match the shell pattern `when`, and is git otherwise.
const ON = (when: string, action: string) => `case " $* " in ${when}) ${action};; esac
exec "$REAL_GIT" "$@"`;

before(() => {
  makeRemote('small', (src) => fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n'));
  makeRemote('hangs', (src) => fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n'));
  makeRemote('medium', (src) => {
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(src, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(30));
  });
  makeRemote('bigfile', (src) => fs.writeFileSync(path.join(src, 'big.ts'), 'x\n'.repeat(3 * 512 * 1024)));
  makeRemote('manyfiles', (src) => {
    for (let d = 0; d < 30; d++) {
      fs.mkdirSync(path.join(src, `d${d}`));
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(src, `d${d}`, `e${i}`), '');
    }
  });
});

after(() => {
  for (const m of ['31415', '27182', '16180', '14142', 'slow-writer']) killAll(m);
  cleanup();
});

// ---------------------------------------------------------------------------------------------------
// The environment overrides
// ---------------------------------------------------------------------------------------------------

for (const name of ['COLLECTOR_SCAN_DEADLINE_MS', 'COLLECTOR_UNPACK_MAX_BYTES', 'COLLECTOR_UNPACK_MAX_ENTRIES']) {
  test(`${name}: zero, a negative number or text falls back to the default`, async () => {
    const outcome: string[] = [];
    for (const value of ['0', '-1', '-5000', 'abc', '30m', '', ' ', 'NaN', 'Infinity']) {
      fs.rmSync(reposDir, { recursive: true, force: true });
      const result = await scan([row('small')], { [name]: value });
      outcome.push(`${JSON.stringify(value)}: ${result.ok === 1 ? 'scanned' : result.error}`);
    }
    // With the default (30 min, 1 GiB, 200000 entries) a one-file repository is scanned.
    assert.deepEqual(outcome.filter((o) => !o.endsWith(': scanned')), [], outcome.join(' | '));
  });
}

test('a time limit longer than Node\'s longest timer (about 24.8 days) does not stop every scan at once', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  // 30 days. setTimeout() takes anything above 2^31-1 ms as 1 ms.
  const result = await scan([row('small')], { COLLECTOR_SCAN_DEADLINE_MS: String(30 * 24 * 60 * 60 * 1000) });
  assert.equal(result.ok, 1, `${result.error} | ${result.stderr.split('\n').find((l) => l.includes('Timeout')) ?? ''}`);
});

// ---------------------------------------------------------------------------------------------------
// At the time limit
// ---------------------------------------------------------------------------------------------------

test('a clone that ignores SIGTERM is killed after the grace time; the scan process itself goes on', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  shim('git', ON('*" clone "*hangs*', 'trap "" TERM; sleep 31415; exit 1'));
  const result = await scan([row('hangs'), row('small')], LIMIT);
  unshim('git');
  assert.equal(result.exit, 0, `the scan process ended with ${result.exit ?? result.signal}`);
  assert.equal(result.failed[0]?.err, STOPPED);
  assert.ok(result.ms < 2 * SOON, `the scan took ${result.ms} ms`);
  assert.deepEqual(running('31415'), [], 'the program is still running');
  assert.deepEqual(tempFolders(), []);
});

test('an archive that arrives slowly is stopped at the limit: git, what it started, and tar are gone, the temp folder too', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  const first = await scan([row('medium')]);
  assert.equal(first.ok, 1, String(first.error));
  // git archive's real output, handed on by a program git started, 512 bytes every 100 ms.
  shim('git', ON('*/medium" archive "*', '"$REAL_GIT" "$@" > "$TMPDIR/slow.tar" || exit 1; python3 -c \'import sys,time\nd=open(sys.argv[1],"rb").read()\nfor i in range(0,len(d),512):\n  sys.stdout.buffer.write(d[i:i+512]); sys.stdout.buffer.flush(); time.sleep(0.1)\' "$TMPDIR/slow.tar" slow-writer; exit 0'));
  const result = await scan([row('medium'), row('small')], LIMIT);
  unshim('git');
  assert.equal(result.failed[0]?.err, STOPPED);
  assert.equal(result.failed.length, 1, 'only that repository fails');
  assert.equal(result.ok, 1, 'the next repository is scanned');
  assert.equal(result.lines['acme/medium'], undefined, 'nothing is stored for the stopped repository');
  assert.ok(result.ms < SOON, `the scan took ${result.ms} ms`);
  assert.deepEqual(running('slow-writer'), []);
  assert.deepEqual(running(`-x -C ${tmp}`), [], 'tar is still running');
  assert.deepEqual(tempFolders(), [], 'the temp folder was left behind');
});

test('a line counter that hangs is stopped at the limit and the repository fails, it is not counted another way', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  shim('scc', 'sleep 14142');
  const result = await scan([row('small')], LIMIT);
  unshim('scc');
  assert.equal(result.failed[0]?.err, STOPPED);
  assert.equal(result.lines['acme/small'], undefined);
  assert.deepEqual(running('14142'), []);
  assert.deepEqual(tempFolders(), []);
});

// ---------------------------------------------------------------------------------------------------
// The caps: what is on disk when the scan notices
// ---------------------------------------------------------------------------------------------------

// tar, and when it ends or is stopped, what it has written: bytes and entries under its target folder.
const TAR_RECORDS = [
  'dest=""; for a in "$@"; do dest="$a"; done',
  'note() { du -sb "$dest" | cut -f1 > "$REC.bytes"; find "$dest" -mindepth 1 | wc -l > "$REC.entries"; }',
  'trap "note; exit 143" TERM',
  // A background job of a script reads /dev/null unless it is given another descriptor.
  'exec 3<&0',
  '"$REAL_TAR" "$@" <&3 &',
  'exec 3<&- 0</dev/null',
  'wait $!; rc=$?',
  'note; exit $rc',
].join('\n');

test('byte cap: a tree over the cap fails with a plain message and no more than the cap was written', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  shim('tar', TAR_RECORDS);
  const rec = path.join(work, 'rec-bytes');
  const cap = 1024 * 1024;
  const result = await scan([row('bigfile'), row('small')], { COLLECTOR_UNPACK_MAX_BYTES: String(cap), REC: rec });
  unshim('tar');
  assert.equal(result.failed[0]?.err, 'the tree is larger than 1 MiB, not counted');
  assert.equal(result.ok, 1, 'the next repository is scanned');
  const written = Number(fs.readFileSync(`${rec}.bytes`, 'utf8'));
  // du counts the folder itself (4096).
  assert.ok(written <= cap + 8192, `${written} bytes were on disk, the cap is ${cap}`);
  assert.deepEqual(tempFolders(), []);
});

test('entry cap: a tree with many empty files fails with a plain message and no more entries than the cap were created', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  shim('tar', TAR_RECORDS);
  const rec = path.join(work, 'rec-entries');
  const result = await scan([row('manyfiles'), row('small')], { COLLECTOR_UNPACK_MAX_ENTRIES: '500', REC: rec });
  unshim('tar');
  assert.equal(result.failed[0]?.err, 'the tree has more than 500 entries, not counted');
  assert.equal(result.ok, 1, 'the next repository is scanned');
  const created = Number(fs.readFileSync(`${rec}.entries`, 'utf8'));
  assert.ok(created <= 500, `${created} entries were on disk, the cap is 500`);
  assert.deepEqual(tempFolders(), []);
});

test('exactly at the caps a tree is still counted', async () => {
  fs.rmSync(reposDir, { recursive: true, force: true });
  // manyfiles: 30 folders and 3000 files are 3030 entries.
  const at = await scan([row('manyfiles')], { COLLECTOR_UNPACK_MAX_ENTRIES: '3030' });
  assert.equal(at.ok, 1, String(at.error));
  const below = await scan([row('manyfiles')], { COLLECTOR_UNPACK_MAX_ENTRIES: '3029' });
  assert.equal(below.failed[0]?.err, 'the tree has more than 3029 entries, not counted');
});
