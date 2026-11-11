// A row of the repos table may only name a repository of the configured organisation (GITHUB_ORG,
// "acme" in the harness), with an id equal to its owner and name. Anything else fails that row before
// any program starts or anything is created. Linux only, like git-scan.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, env, listing, makeRemote, rawGit, reposDir, row, scanRows } from './scan-harness.js';

before(() => {
  makeRemote('clean', 'main');
  // A repository outside the organisation that git could clone.
  makeRemote('other', 'main', (src) => {
    fs.writeFileSync(path.join(src, 'b.ts'), 'not ours\n');
    rawGit(src, 'add', '.');
    rawGit(src, 'commit', '-q', '-m', 'stranger');
  }, 'stranger');
});

after(cleanup);

test('a row whose owner is not the organisation starts nothing and creates nothing', async (t) => {
  const before = listing(reposDir);
  const result = await scanRows(t, [{ id: 'stranger/other', owner: 'stranger', name: 'other', default_branch: 'main' }]);
  assert.equal(result.err, 1, 'a repository outside the organisation was scanned');
  assert.equal(result.error, 'stranger/other: owner is not the configured organisation (acme)');
  assert.deepEqual(result.argv, [], `started ${result.argv.map((a) => a.slice(0, 2).join(' ')).join(', ')}`);
  assert.deepEqual(listing(reposDir), before, 'something was created under the repos folder');
});

test('a row with an organisation id but another owner and name leaves the existing clone alone', async (t) => {
  const first = await scanRows(t, [row('clean', 'main')]);
  assert.equal(first.ok, 1, String(first.error));
  const config = path.join(reposDir, 'acme', 'clean', 'config');
  const configBefore = fs.readFileSync(config, 'utf8');
  const refsBefore = rawGit(path.join(reposDir, 'acme', 'clean'), 'for-each-ref');

  for (const r of [
    { id: 'acme/clean', owner: 'stranger', name: 'other', default_branch: 'main' },
    { id: 'acme/clean', owner: 'acme', name: 'other', default_branch: 'main' },
    { id: 'acme/other', owner: 'acme', name: 'clean', default_branch: 'main' },
  ]) {
    const result = await scanRows(t, [r]);
    const shown = `${r.id} as ${r.owner}/${r.name}`;
    assert.equal(result.err, 1, `${shown} was scanned`);
    assert.deepEqual(result.argv, [], `${shown}: started ${result.argv.map((a) => a.slice(0, 2).join(' ')).join(', ')}`);
  }
  assert.equal(fs.readFileSync(config, 'utf8'), configBefore, 'the clone\'s remote was changed');
  assert.equal(rawGit(path.join(reposDir, 'acme', 'clean'), 'for-each-ref'), refsBefore, 'the clone\'s branches were replaced');
  assert.equal(fs.existsSync(path.join(reposDir, 'acme', 'other')), false);
});

test('the owner is compared with the organisation without regard to case, as GitHub does', async (t) => {
  t.after(() => { env.githubOrg = 'acme'; });
  env.githubOrg = 'ACME';
  const result = await scanRows(t, [row('clean', 'main')]);
  assert.equal(result.ok, 1, String(result.error));
});
