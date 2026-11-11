// The unpack step gives the same result every time: the same ordinary repositories are scanned
// many times and every scan has to succeed. SCAN_ROUNDS changes the number of rounds. Linux only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, leftoverTemp, makeRemote, rawGit, row, scanRows } from './scan-harness.js';

const ROUNDS = Number(process.env.SCAN_ROUNDS || 60);

before(() => {
  makeRemote('tiny', 'main');
  makeRemote('medium', 'main', (src) => {
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(src, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(40));
    rawGit(src, 'add', '.');
    rawGit(src, 'commit', '-q', '-m', 'files');
  });
  makeRemote('empty-tree', 'main', (src) => {
    rawGit(src, 'rm', '-q', 'a.ts');
    rawGit(src, 'commit', '-q', '-m', 'empty');
  });
});

after(cleanup);

test(`the same ordinary repositories scan successfully ${ROUNDS} times in a row`, async (t) => {
  const failures = new Map<string, number>();
  let scans = 0;
  for (let i = 0; i < ROUNDS; i++) {
    for (const name of ['tiny', 'medium', 'empty-tree']) {
      const result = await scanRows(t, [row(name, 'main')]);
      scans++;
      if (result.ok !== 1) {
        const key = `${name}: ${String(result.error).replace(/^[^:]*: /, '')}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
  }
  t.diagnostic(`${scans} scans, failures: ${JSON.stringify([...failures])}`);
  assert.deepEqual(leftoverTemp(), []);
  assert.equal(failures.size, 0, `${[...failures].map(([k, n]) => `${n}x ${k}`).join(' | ')}`);
});
