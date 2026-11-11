// The stack's configuration lives in templates, a compose file and deploy.sh, which nothing else
// checks. These read them the way dashboards.test.ts reads the Grafana files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const withoutComments = (text: string) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

function bytes(size: string): number {
  const m = /^(\d+)([kKmM]?)$/.exec(size);
  assert.ok(m, `not a size: ${size}`);
  return Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1024 : m[2].toLowerCase() === 'm' ? 1024 * 1024 : 1);
}

test('the telemetry vhost lets through what the collector accepts', () => {
  const vhost = withoutComments(read('nginx/telemetry.conf.template'));
  const sizes = [...vhost.matchAll(/client_max_body_size\s+(\w+)\s*;/g)].map((m) => bytes(m[1]));
  assert.ok(sizes.length > 0, 'no client_max_body_size');
  // The collector reads up to 64 KiB; a schema 2 heartbeat with nine errors is already over 8k.
  assert.ok(Math.min(...sizes) >= 64 * 1024, `a body limit of ${Math.min(...sizes)} bytes is below the collector's 64 KiB`);
  assert.match(vhost, /location\s+=\s+\/v1\/errors\s*\{[^}]*proxy_pass\s+http:\/\/127\.0\.0\.1:\d+\/v1\/errors\s*;/, 'instant error counts have no route');
  // Addresses still never reach the collector on either route.
  for (const route of ['/v1/heartbeat', '/v1/errors']) {
    const at = vhost.indexOf(`location = ${route}`);
    const block = vhost.slice(at, vhost.indexOf('}', at));
    assert.match(block, /proxy_set_header\s+X-Forwarded-For\s+""\s*;/, `${route} forwards the client address`);
  }
});

test('the version vhost serves the Android download route', () => {
  assert.match(withoutComments(read('nginx/version.conf.template')), /location\s+(=\s+|\^~\s+)?\/android\//);
});

test('Prometheus scrapes the relay with its token, from a file the compose file mounts', () => {
  const prometheus = withoutComments(read('prometheus/prometheus.yml'));
  const relay = prometheus.slice(prometheus.indexOf('job_name: relay'));
  const job = relay.slice(0, relay.indexOf('- job_name:', 10) === -1 ? undefined : relay.indexOf('- job_name:', 10));
  const file = /authorization:\s*\n\s*(?:type:\s*Bearer\s*\n\s*)?credentials_file:\s*(\S+)/.exec(job)?.[1];
  assert.ok(file, 'the relay job sends no credentials');
  assert.ok(withoutComments(read('docker-compose.yml')).includes(`:${file}`), `the compose file mounts nothing at ${file}`);
  assert.doesNotMatch(job, /credentials:\s*\S/, 'the token itself is in the repo');
  // The file on the host stays out of git.
  assert.match(read('.gitignore'), /^\/?secrets\/\s*$/m);
});

test('.env.example names every variable the compose file needs and none that nothing reads', () => {
  const example = new Set([...read('.env.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const needed = new Set([...withoutComments(read('docker-compose.yml')).matchAll(/\$\{([A-Z][A-Z0-9_]+)[:?}-]/g)].map((m) => m[1]));
  for (const name of needed) assert.ok(example.has(name), `.env.example has no ${name}`);
  for (const name of ['BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD']) {
    const used = ['deploy.sh', 'docker-compose.yml', 'nginx/grafana.conf.template'].some((file) => withoutComments(read(file)).includes(name));
    assert.ok(used || !example.has(name), `.env.example still lists ${name}, which nothing uses`);
  }
});

test('Grafana\'s own metrics are not served without a login', () => {
  const compose = withoutComments(read('docker-compose.yml'));
  const vhost = withoutComments(read('nginx/grafana.conf.template'));
  const off = /GF_METRICS_ENABLED:\s*"?false"?/.test(compose);
  const blocked = /location\s+=\s+\/metrics\s*\{\s*return\s+40[34]\s*;/.test(vhost);
  assert.ok(off || blocked, 'GET /metrics on the admin vhost reaches Grafana, which answers it without a login');
  // Both, so one change on its own doesn't open it again.
  assert.ok(off && blocked, 'only one of the two layers is in place');
});

test('signing in through the identity provider does not make everyone a Viewer', () => {
  const compose = withoutComments(read('docker-compose.yml'));
  const path = /GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH:\s*"([^"]*)"/.exec(compose)?.[1] ?? '';
  const strict = /GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT:\s*"?true"?/.test(compose);
  const signUpOff = /GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP:\s*"?false"?/.test(compose);
  // Either nobody new gets an account by signing in, or a user without a named role is refused.
  const fallsBackToViewer = /\|\|\s*'Viewer'\s*$/.test(path.trim());
  assert.ok(signUpOff || (strict && !fallsBackToViewer), 'a user the provider lets through without any Grafana role becomes a Viewer');
});
