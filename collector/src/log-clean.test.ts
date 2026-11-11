// errorText() and the forms a credential can take in a URL, a header or a JSON body, and its cost on
// long input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from './log.js';

const TOKEN = 'ghp_FAKEcleanFAKEcleanFAKEclean0000000';
const ODD = 'ghp_FAKE+clean/with=chars%00';
const basic = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');

function clean(sample: string, token = TOKEN): string {
  return errorText(new Error(sample), [token, basic(token)]);
}

function absent(out: string, token: string, what: string): void {
  for (const form of [token, basic(token), encodeURIComponent(token), Buffer.from(token).toString('base64')]) {
    assert.ok(!out.includes(form), `${what}: ${JSON.stringify(out.slice(0, 200))}`);
  }
  // No 12 characters in a row of the token or of its Basic form.
  for (const secret of [token, basic(token)]) {
    for (let i = 0; i + 12 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 12)), `${what}: part of the credential is left: ${JSON.stringify(out.slice(0, 200))}`);
  }
}

test('known token: every spelling a URL, a header or a JSON body could carry', () => {
  for (const token of [TOKEN, ODD]) {
    const b = basic(token);
    const samples: Array<[string, string]> = [
      ['upper-case scheme and host', `fatal: unable to access 'HTTPS://X-ACCESS-TOKEN:${token}@GITHUB.COM/acme/x.git/'`],
      ['percent-encoded in a URL', `fatal: https://x-access-token:${encodeURIComponent(token)}@github.com/acme/x.git`],
      ['lower-case percent-encoding', `fatal: https://x-access-token:${encodeURIComponent(token).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}@github.com/acme/x.git`],
      ['user only', `fatal: https://${encodeURIComponent(token)}@github.com/acme/x.git`],
      ['basic header', `> Authorization: Basic ${b}`],
      ['basic header, lower case', `authorization: basic ${b}`],
      ['basic header without a space', `Authorization:Basic ${b}`],
      ['header in a config dump', `http.https://github.com/.extraheader=Authorization: Basic ${b}`],
      ['environment dump', `GIT_CONFIG_VALUE_0=Authorization: Basic ${b}\nGITHUB_TOKEN=${token}`],
      ['json body', `{"message":"Bad credentials","sent":{"authorization":"Basic ${b}"},"token":"${token}"}`],
      ['json body, escaped twice', `{"error":"{\\"authorization\\":\\"Basic ${b}\\",\\"token\\":\\"${token}\\"}"}`],
      ['json header list', `{"headers":{"Authorization":["Basic ${b}"]}}`],
      ['bearer', `Authorization: Bearer ${token}`],
      ['query string', `GET /x?access_token=${token}&y=1 failed`],
      ['ssh style', `fatal: x-access-token:${token}@github.com:acme/x.git`],
      ['at the 300 cut', `${'y'.repeat(285)} ${token}`],
      ['basic at the 300 cut', `${'y'.repeat(270)} Basic ${b}`],
      ['url at the 300 cut', `${'y'.repeat(262)} https://x-access-token:${token}@github.com/acme/x.git`],
      ['twice', `${token} and again ${token}`],
    ];
    for (const [what, sample] of samples) absent(clean(sample, token), token, `${what}${token === ODD ? ' (token with URL characters)' : ''}`);
  }
});

test('a credential the cleaning was not told about, in the forms the old clones and GitHub use', () => {
  const other = 'ghp_FAKEotherFAKEotherFAKEotherFAKE00000';
  const samples: Array<[string, string]> = [
    ['old clone URL', `fatal: unable to access 'https://x-access-token:${other}@github.com/acme/x.git/': 403`],
    ['upper-case scheme', `HTTPS://x-access-token:${other}@github.com/acme/x.git`],
    ['basic of another token', `Authorization: Basic ${basic(other)}`],
    ['bare basic', `server said: Basic ${basic(other)}`],
    ['token scheme', `authorization: token ${other}`],
    ['json authorization', `{"authorization":"token ${other}"}`],
  ];
  for (const [what, sample] of samples) {
    const out = errorText(sample);
    assert.ok(!out.includes(other) && !out.includes(basic(other)), `${what}: ${JSON.stringify(out)}`);
  }
});

test('the cleaning does not take much longer per character on long input', () => {
  // Growth, not time: four times the input takes about 4 times as long for linear rules and about
  // 16 times for a quadratic one. The fastest of five runs each keeps other test files' load out.
  for (const unit of ['a.', '-eyJa', 'https:x', 'Basic ']) {
    const time = (n: number) => {
      const text = unit.repeat(n);
      const start = process.hrtime.bigint();
      errorText(text, [], 200);
      return Number(process.hrtime.bigint() - start);
    };
    const fastest = (n: number) => Math.min(...Array.from({ length: 5 }, () => time(n)));
    time(2000);
    const small = fastest(20000);
    const large = fastest(80000);
    assert.ok(large / small < 10, `${JSON.stringify(unit)}: 4 times the input took ${(large / small).toFixed(1)} times as long`);
  }
});
