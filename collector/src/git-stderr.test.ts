// What reaches the run table and the log when git writes odd things to stderr, and what the fallback
// line count does with names that are no UTF-8. Every scan runs in a process of its own.
// Linux only, like git-scan.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, makeRemote, reposDir, row, scan, shim, unshim, work } from './scan-process.js';

const TOKEN = 'ghp_FAKEstderrFAKEstderrFAKEstderr00000';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const ENV = { GITHUB_TOKEN: TOKEN };

before(() => {
  makeRemote('small', (src) => fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n'));
  makeRemote('oddfolder', (src) => {
    fs.writeFileSync(path.join(src, 'a.ts'), 'one\ntwo\n');
    // A folder and a file whose names are no UTF-8 (Latin-1 bytes), with 3 and 4 lines in them.
    const dir = Buffer.concat([Buffer.from(`${src}/caf`), Buffer.from([0xe9])]);
    fs.mkdirSync(dir);
    fs.writeFileSync(Buffer.concat([dir, Buffer.from('/b.ts')]), '1\n2\n3\n');
    fs.writeFileSync(Buffer.concat([Buffer.from(`${src}/na`), Buffer.from([0xef]), Buffer.from('ve.ts')]), '1\n2\n3\n4\n');
  });
});

after(cleanup);

function absent(text: string, what: string): void {
  for (const secret of [TOKEN, BASIC]) {
    for (let i = 0; i + 12 <= secret.length; i++) assert.ok(!text.includes(secret.slice(i, i + 12)), `${what}: part of the credential is in ${JSON.stringify(text.slice(0, 400))}`);
  }
}

// A git whose clone fails after writing the file $STDERR_FILE to stderr, in the pieces `pieces` names.
const FAILING_CLONE = [
  'case " $* " in *" clone "*)',
  '  python3 -c \'import sys,time,os',
  'd=open(os.environ["STDERR_FILE"],"rb").read(); n=int(os.environ.get("PIECE","0")) or len(d) or 1',
  'for i in range(0,len(d),n):',
  '  sys.stderr.buffer.write(d[i:i+n]); sys.stderr.buffer.flush(); time.sleep(0.002)\' ; exit 128;;',
  'esac',
  'exec "$REAL_GIT" "$@"',
].join('\n');

test('odd stderr of a failing git: long lines, the credential across pieces, no line end', async () => {
  shim('git', FAILING_CLONE);
  const file = path.join(work, 'stderr.txt');
  const url = `https://x-access-token:${TOKEN}@github.com/acme/small.git`;
  const samples: Array<[string, Buffer | string, string?]> = [
    ['a fatal line of 60 KB with the URL at its end', `fatal: ${'x'.repeat(60000)} unable to access '${url}'\n`],
    ['a fatal line of 60 KB, the URL across the 300th character', `fatal: ${'x'.repeat(270)} '${url}' ${'y'.repeat(60000)}\n`],
    ['a line of 200 KB with the token, then a short fatal line', `warning: ${'x'.repeat(100000)} ${TOKEN} ${'x'.repeat(100000)}\nfatal: short\n`],
    ['a fatal line of 200 KB with the token', `fatal: ${'x'.repeat(100000)} ${TOKEN} ${BASIC} ${'x'.repeat(100000)}\n`],
    ['70 KB of short lines with the token in each', `remote: Authorization: Basic ${BASIC} for ${url}\n`.repeat(400)],
    ['the header in pieces of 7 bytes', `> Authorization: Basic ${BASIC}\nfatal: unable to access '${url}': 403\n`, '7'],
    ['the URL in pieces of 1 byte', `fatal: unable to access '${url}': 403\n`, '1'],
    ['no line end at all', `fatal: unable to access '${url}'`],
    ['carriage returns', `remote: ${TOKEN}\rremote: ${BASIC}\r\nfatal: '${url}'\r\n`],
    ['bytes that are no UTF-8 around the token', Buffer.concat([Buffer.from('fatal: '), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(`${TOKEN} ${url}`), Buffer.from([0xc3, 0x0a])])],
    ['a NUL before the token', `fatal: x\0${TOKEN}\0${BASIC}\n`],
    ['2 MB without a line end, the token at the end', `${'x'.repeat(2 * 1024 * 1024)}${TOKEN}`],
    ['nothing', ''],
  ];
  for (const [what, text, piece] of samples) {
    fs.rmSync(reposDir, { recursive: true, force: true });
    fs.writeFileSync(file, text);
    const result = await scan([row('small')], { ...ENV, STDERR_FILE: file, PIECE: piece ?? '0' });
    assert.equal(result.err, 1, what);
    const stored = String(result.error);
    absent(stored, `${what}, run table`);
    absent(result.log, `${what}, log`);
    assert.ok(stored.length <= 520, `${what}: the stored error has ${stored.length} characters`);
    assert.ok(!/[\r\n]/.test(stored.trim()) || what === 'carriage returns', `${what}: the stored error has more than one line`);
    assert.match(stored, /^acme\/small: git clone failed: /, what);
  }
  unshim('git');
});

test('without scc, a folder or file whose name is no UTF-8 is counted like any other', async () => {
  // a.ts 2 lines, the file in the folder 3, the other file 4: 9 lines. PATH holds no scc here.
  fs.rmSync(reposDir, { recursive: true, force: true });
  const result = await scan([row('oddfolder')], { ...ENV, PATH: '/usr/bin:/bin' });
  assert.equal(result.ok, 1, String(result.error));
  assert.equal(result.lines['acme/oddfolder'], 9, `${result.lines['acme/oddfolder']} lines were counted`);
});
