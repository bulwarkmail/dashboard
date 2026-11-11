// runTestflight() with a generated key and fetch replaced: nothing leaves the machine.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testflight-'));
const keyFile = path.join(dir, 'AuthKey_FAKE.p8');
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
fs.writeFileSync(keyFile, pem);

process.env.GITHUB_TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE0000';
process.env.POSTGRES_DASHBOARD_PASSWORD = 'test';
process.env.ASC_KEY_FILE = keyFile;
process.env.ASC_KEY_ID = 'FAKEKEYID';
process.env.ASC_ISSUER_ID = '00000000-0000-0000-0000-000000000000';

const { runTestflight } = await import('./testflight.js');

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers every request with `status` and a body made from the request's Authorization header. */
function answer(t: import('node:test').TestContext, status: number, body: (authorization: string) => string): void {
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    return new Response(body(authorization), { status });
  });
}

async function failure(): Promise<string> {
  try {
    await runTestflight();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  assert.fail('runTestflight() did not fail');
}

test('an error answer that repeats the request token is logged without it', async (t) => {
  let sent = '';
  answer(t, 401, (authorization) => {
    sent = authorization;
    return JSON.stringify({ errors: [{ status: '401', code: 'NOT_AUTHORIZED', detail: `Authorization: ${authorization}` }] });
  });
  const message = await failure();
  const jwt = sent.replace(/^Bearer /, '');
  assert.ok(jwt.length > 40, 'a token was sent');
  assert.match(message, /HTTP 401/);
  assert.ok(!message.includes(jwt.slice(0, 40)), `the error holds the request token: ${message}`);
});

test('an error answer that holds a private key is logged without it', async (t) => {
  answer(t, 500, () => pem);
  const message = await failure();
  const keyLine = pem.split('\n')[1];
  assert.ok(!message.includes(keyLine.slice(0, 20)), `the error holds the key: ${message}`);
});
