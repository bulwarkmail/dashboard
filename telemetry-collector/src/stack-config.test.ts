// The stack's configuration lives in templates, a compose file and deploy.sh, which nothing else
// checks. These read them the way dashboards.test.ts reads the Grafana files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const withoutComments = (text: string) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

test('signing in through the identity provider does not make everyone a Viewer', () => {
  const compose = withoutComments(read('docker-compose.yml'));
  const path = /GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH:\s*"([^"]*)"/.exec(compose)?.[1] ?? '';
  const strict = /GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT:\s*"?true"?/.test(compose);
  const signUpOff = /GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP:\s*"?false"?/.test(compose);
  // Either nobody new gets an account by signing in, or a user without a named role is refused.
  const fallsBackToViewer = /\|\|\s*'Viewer'\s*$/.test(path.trim());
  assert.ok(signUpOff || (strict && !fallsBackToViewer), 'a user the provider lets through without any Grafana role becomes a Viewer');
});
