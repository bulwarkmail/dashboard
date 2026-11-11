import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from './log.js';

// Fake values, with characters that mean something in a URL and in base64.
const TOKEN = 'ghp_FAKE+token/with=chars0000';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

test('error text loses the token in every form git or a server could print it', () => {
  const samples = [
    `Command failed: git clone --bare --filter=blob:none https://x-access-token:${TOKEN}@github.com/acme/x.git /data/repos/acme/x`,
    `fatal: unable to access 'https://x-access-token:${encodeURIComponent(TOKEN)}@github.com/acme/x.git/': The requested URL returned error: 403`,
    `http.https://github.com/.extraheader=Authorization: Basic ${BASIC}`,
    `{"request":{"headers":{"authorization":"Basic ${BASIC}"}}}`,
    `bare credential ${BASIC} in the middle`,
  ];
  for (const sample of samples) {
    const out = errorText(new Error(sample), [TOKEN, BASIC]);
    for (const form of [TOKEN, BASIC, encodeURIComponent(TOKEN)]) {
      assert.ok(!out.includes(form), `${JSON.stringify(out)} still holds ${form === TOKEN ? 'the token' : 'an encoded token'}`);
    }
  }
});

test('error text loses credentials it was not told about', () => {
  const jwt = 'eyJhbGciOiJFUzI1NiIsImtpZCI6IkZBS0UifQ.eyJpc3MiOiJmYWtlIiwiYXVkIjoiYXBwc3RvcmVjb25uZWN0LXYxIn0.FAKEsignatureFAKEsignature';
  const key = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFAKEFAKEFAKE\n-----END PRIVATE KEY-----';
  const cases: Array<[string, string]> = [
    ['https://someone:pa%2Bss%2Fw%3Drd@example.org/x.git', 'pa%2Bss'],
    ['https://x-access-token:ghp_FAKEotherFAKEotherFAKE0000@github.com/acme/x.git', 'ghp_FAKEother'],
    ['Authorization: token ghp_FAKEotherFAKEotherFAKE0000', 'ghp_FAKEother'],
    [`detail: Bearer ${jwt}`, 'FAKEsignature'],
    [`{"authorization":"Bearer abc.def.ghi-FAKE"}`, 'abc.def.ghi'],
    [`answer: ${jwt}`, 'eyJpc3Mi'],
    [`key: ${key}`, 'MIGHAgEA'],
  ];
  for (const [sample, secret] of cases) {
    const out = errorText(sample);
    assert.ok(!out.includes(secret), `${JSON.stringify(out)} still holds ${secret}`);
  }
});

test('error text keeps plain messages and cuts long ones', () => {
  const plain = "git fetch failed: fatal: repository 'https://github.com/acme/x.git/' not found";
  assert.equal(errorText(new Error(plain)), plain);
  assert.ok(errorText('x'.repeat(5000)).length <= 303);
  assert.ok(errorText('x'.repeat(5000), [], 200).length <= 203);
});
