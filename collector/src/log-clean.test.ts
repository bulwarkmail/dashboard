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

// [name, what comes first, what is repeated]: long runs of the characters the rules start with, and of
// what makes each rule look ahead (no end of the user part, no colon after "authorization", no second dot ...).
const SHAPES: Array<[string, string, string]> = [
  ['a.', '', 'a.'],
  ['letters', '', 'a'],
  ['a+ (scheme characters)', '', 'a+'],
  ['a:', '', 'a:'],
  ['a://', '', 'a://'],
  ['one scheme, then no @', 'https://', 'x'],
  ['one scheme, then dots and no @', 'https://', 'x.'],
  ['scheme starts every 2 characters, user part never ends', '', 'a.a.a.a.a.a.a.a.a.a.a.a.a.a.://xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx '],
  ['-----BEGIN ', '', '-----BEGIN '],
  ['-----BEGIN and no dash after', '-----BEGIN ', 'x'],
  ['a key block that never ends', '-----BEGIN PRIVATE KEY-----', 'x\n'],
  ['key header, then -----END that is none', '-----BEGIN PRIVATE KEY-----', '-----END xxxxxxxxxxxxxxxx'],
  ['key header, then one -----END and no dash', '-----BEGIN PRIVATE KEY----- -----END ', 'x'],
  ['key header, then dashes', '-----BEGIN PRIVATE KEY-----', '-'],
  ['authorization', '', 'authorization'],
  ['authorization and a space', '', 'authorization '],
  ['authorization, then spaces', 'authorization', ' '],
  ['authorization, then newlines', 'authorization', '\n'],
  ['proxy-', '', 'proxy-'],
  ['authorization: and a long value', 'authorization:', 'x'],
  ['Basic ', '', 'Basic '],
  ['basic, then spaces', 'basic', ' '],
  ['token and 7 characters', '', 'token abcdefg '],
  ['bearer, then a long value', 'bearer ', 'a'],
  ['eyJ', '', 'eyJ'],
  ['-eyJa', '', '-eyJa'],
  [' eyJaaaa', '', ' eyJaaaa'],
  ['eyJaaaa., then letters', 'eyJaaaa.', 'a'],
  [' eyJaaaa.aaaa', '', ' eyJaaaa.aaaa'],
  ['at signs', '', '@'],
  ['dashes', '', '-'],
  ['spaces', '', ' '],
  ['the secret itself', '', `${TOKEN} `],
  ['the secret\'s start, again and again', '', TOKEN.slice(0, 20)],
];

test('the cleaning reads each character a bounded number of times: four times the input, about four times the reads', () => {
  // Counted character reads, not time: a rule that looks at every character a bounded number of times
  // reads about 4 times as much for 4 times the input; a rule that starts over at every character
  // reads about 16 times as much.
  const rows: string[] = [];
  for (const [what, head, unit] of SHAPES) {
    const reads = (chars: number) => {
      const counter = { count: 0 };
      errorText(head + unit.repeat(Math.ceil(chars / unit.length)), [TOKEN, basic(TOKEN)], 300, counter);
      return counter.count;
    };
    const small = reads(1 << 14);
    const large = reads(1 << 16);
    rows.push(`${what}: ${(large / small).toFixed(2)}`);
    assert.ok(large / small < 5, `${what}: 4 times the input took ${(large / small).toFixed(2)} times the reads`);
    // And a bounded number per character: the secrets are at most 70 characters long.
    assert.ok(large < 120 * (1 << 16), `${what}: ${large} reads for ${1 << 16} characters`);
  }
  console.log(`# reads for 64 KB / 16 KB\n# ${rows.join('\n# ')}`);
});

// The rules as regular expressions: what the cleaning did before it counted its reads, kept here to
// check that the passes replace exactly the same text.
function byExpressions(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join('<redacted>');
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '<redacted key>')
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@'"]*@/gi, '$1')
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\r\n"']*/gi, '$1<redacted>')
    .replace(/\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2<redacted>')
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<redacted jwt>');
}

test('the counted passes replace exactly what the regular expressions replaced', () => {
  // Texts built from the pieces the rules look for, with a fixed seed so a failure can be repeated.
  const pieces = [
    'a', 'b', 'x', 'Z', '0', '7', '.', '-', '_', '+', '~', '/', '=', ':', '//', '://', '@', "'", '"', ' ', '\t', '\n', '\r',
    '\u00a0', '\u2028', 'é', '<', 'https', 'HTTP', 'git+ssh', 'x-access-token', 'authorization', 'Authorization',
    'AUTHORIZATION', 'proxy-', 'Proxy-', 'bearer', 'Bearer', 'basic', 'BASIC', 'token', 'Token', 'abcdefgh', 'eyJ',
    'eyJabcd', '.efgh', '-----', '-----BEGIN ', 'RSA ', 'PRIVATE KEY', 'PRIVATE KEY-----', '-----END ', TOKEN.slice(0, 12), TOKEN,
    'eyJhbGciOiJ.', 'Ab0_-x.', '.Ab0_', 'user:pw@', 'h://', 'ftp://u@',
  ];
  let seed = 20261112;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  for (let round = 0; round < 20000; round++) {
    let text = '';
    const count = random(40);
    for (let i = 0; i < count; i++) text += pieces[random(pieces.length)];
    const secrets = round % 3 === 0 ? [TOKEN, basic(TOKEN)] : [];
    const expected = byExpressions(text, secrets);
    assert.equal(errorText(text, secrets, 1e9), expected, `round ${round}: ${JSON.stringify(text)}`);
  }
});
