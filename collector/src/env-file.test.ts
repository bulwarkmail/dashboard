// Which .env the collector reads: its own collector/.env (which deploy.sh writes with the collector's
// variables only) in preference to the stack's .env, so the stack's file can be closed to the collector's
// account. env.ts is copied into a temp folder laid out like the install, so no real .env is touched.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const STACK = 'GITHUB_TOKEN=ghp_FAKEstackFAKEstackFAKEstack0000000\nGITHUB_ORG=fromstack\nPOSTGRES_DASHBOARD_PASSWORD=fake-stack\nGRAFANA_ADMIN_PASSWORD=fake-grafana\n';
const OWN = 'GITHUB_TOKEN=ghp_FAKEownFAKEownFAKEownFAKEown000000\nGITHUB_ORG=fromcollector\nPOSTGRES_DASHBOARD_PASSWORD=fake-own\n';

/** An install folder with env.ts in collector/src; returns what the collector's settings are there. */
function load(name: string, files: { stack?: string | 'folder'; own?: string }): { org: string; password: string; grafana: string | null } {
  const install = path.join(root, name);
  fs.mkdirSync(path.join(install, 'collector', 'src'), { recursive: true });
  fs.copyFileSync(path.join(here, 'env.ts'), path.join(install, 'collector', 'src', 'env.ts'));
  fs.writeFileSync(path.join(install, 'collector', 'package.json'), '{ "type": "module" }\n');
  // A folder named .env stands for a file the account may not read (root reads every file).
  if (files.stack === 'folder') fs.mkdirSync(path.join(install, '.env'));
  else if (files.stack !== undefined) fs.writeFileSync(path.join(install, '.env'), files.stack);
  if (files.own !== undefined) fs.writeFileSync(path.join(install, 'collector', '.env'), files.own);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot };
  const script = `const m = await import(${JSON.stringify(pathToFileURL(path.join(install, 'collector', 'src', 'env.ts')).href)});
    console.log(JSON.stringify({ org: m.env.githubOrg, password: m.env.pgPassword, grafana: process.env.GRAFANA_ADMIN_PASSWORD ?? null }));`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, cwd: path.dirname(here), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

test('with only the stack\'s .env the collector reads it, as before', () => {
  assert.deepEqual(load('stack-only', { stack: STACK }), { org: 'fromstack', password: 'fake-stack', grafana: 'fake-grafana' });
});

test('collector/.env is read in preference to the stack\'s .env', () => {
  const got = load('both', { stack: STACK, own: OWN });
  assert.equal(got.org, 'fromcollector');
  assert.equal(got.password, 'fake-own');
});

test('with collector/.env the collector starts although it can\'t read the stack\'s .env', () => {
  let got: ReturnType<typeof load> | null = null;
  let failure = '';
  try { got = load('own-only-readable', { stack: 'folder', own: OWN }); } catch (e) { failure = String((e as { stderr?: string }).stderr ?? e).split('\n').find((l) => /Error|EISDIR|EACCES/.test(l)) ?? String(e); }
  assert.ok(got, `the collector did not start: ${failure}`);
  assert.equal(got.org, 'fromcollector');
});

test('with collector/.env the other services\' secrets are not loaded into the collector', () => {
  assert.equal(load('no-foreign', { stack: STACK, own: OWN }).grafana, null);
});

test('env.ts names collector/.env the way the stack\'s deploy.sh looks for it', () => {
  // deploy.sh closes the stack's .env to the collector's account once this text is in env.ts:
  //   grep -qF "path.resolve(here, '..', '.env')" collector/src/env.ts
  assert.ok(fs.readFileSync(path.join(here, 'env.ts'), 'utf8').includes("path.resolve(here, '..', '.env')"));
});
