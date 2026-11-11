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

test('.env.example names the collector\'s settings, and the README the version server\'s health fields', () => {
  const example = read('.env.example');
  const collectorReads = [...read('collector/src/env.ts').matchAll(/num\('(COLLECTOR_[A-Z0-9_]+)'/g)].map((m) => m[1]);
  const limits = ['COLLECTOR_SCAN_DEADLINE_MS', 'COLLECTOR_UNPACK_MAX_BYTES', 'COLLECTOR_UNPACK_MAX_ENTRIES'];
  for (const name of new Set([...collectorReads, ...limits, 'GITHUB_ORG'])) {
    assert.match(example, new RegExp(`^#?${name}=`, 'm'), `.env.example has no ${name}`);
  }
  const readme = read('README.md');
  for (const word of [...limits, 'GITHUB_ORG', 'overrides.json', 'overridesStale', 'overridesProblem']) {
    assert.ok(readme.includes(word), `the README doesn't mention ${word}`);
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

test('every image is pinned to a version, and nothing is downloaded at container start', () => {
  const compose = withoutComments(read('docker-compose.yml'));
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(images.length >= 4);
  for (const image of images) {
    const tag = image.includes('@sha256:') ? 'digest' : image.split(':')[1] ?? '';
    assert.ok(tag === 'digest' || /\d+\.\d+/.test(tag) || /^\d+(-|$)/.test(tag), `${image} is not pinned to a version`);
    assert.doesNotMatch(image, /latest/, `${image} floats`);
    // A version for the reader and Dependabot, the digest for what runs.
    assert.match(image, /:v?\d+\.\d+(\.\d+)?[\w.-]*@sha256:[0-9a-f]{64}$/, `${image} has no version and digest`);
  }
  assert.doesNotMatch(compose, /GF_INSTALL_PLUGINS/, 'a plugin is downloaded at every start of the Grafana container');
  assert.match(read('.github/dependabot.yml'), /package-ecosystem:\s*docker-compose/);
});

test('deploy.sh checks the scc download against a pinned sha256 before installing it', () => {
  const deploy = withoutComments(read('deploy.sh'));
  const at = deploy.indexOf('scc_Linux');
  assert.ok(at >= 0);
  const step = deploy.slice(at, deploy.indexOf('install -m', at));
  assert.match(step, /sha256sum\s+(-c|--check)/, 'scc is installed to /usr/local/bin without a checksum');
  assert.match(deploy, /\b[0-9a-f]{64}\b/, 'no sha256 is pinned in deploy.sh');
});

test('deploy.sh creates the shared docker network before it starts the stack', () => {
  const deploy = withoutComments(read('deploy.sh'));
  // The compose file joins Prometheus to it as an external network, which has to exist.
  assert.match(read('docker-compose.yml'), /\n {2}bulwark:\r?\n {4}external: true/);
  const created = deploy.indexOf('docker network create bulwark');
  assert.ok(created >= 0, 'deploy.sh does not create the network');
  assert.ok(created < deploy.indexOf('docker compose up -d'), 'the stack starts before the network exists');
});

test('Prometheus has no lifecycle API', () => {
  assert.doesNotMatch(withoutComments(read('docker-compose.yml')), /--web\.enable-lifecycle/);
  assert.doesNotMatch(withoutComments(read('docker-compose.yml')), /--web\.enable-admin-api/);
});

test('no password is on a command line in deploy.sh, and Umami is not announced with its default login', () => {
  const deploy = withoutComments(read('deploy.sh'));
  assert.doesNotMatch(deploy, /curl[^\n]*\s(-u|--user)\s/, 'curl gets the Grafana admin password as an argument');
  assert.doesNotMatch(deploy, /admin\s*\/\s*umami/, 'the deploy leaves Umami on its default login');
  for (const file of ['nginx/umami.conf.template', 'nginx/grafana.conf.template', 'nginx/grafana-public.conf.template']) {
    assert.doesNotMatch(withoutComments(read(file)), /\$proxy_add_x_forwarded_for/, `${file} passes on an X-Forwarded-For the visitor wrote`);
  }
  // Generated secrets reach .env through shell builtins, not through sed's or curl's arguments.
  assert.doesNotMatch(deploy, /sed[^\n]*\$\(rand\)/, 'a generated secret is on sed\'s command line');
  assert.match(deploy, /--netrc-file/);
  assert.doesNotMatch(deploy, /curl[^\n]*(PASSWORD|\$token)/, 'curl gets a secret as an argument');
});

test('Umami\'s app stays closed until deploy.sh has replaced its default login', () => {
  const vhost = withoutComments(read('nginx/umami.conf.template'));
  // The tracker always works.
  for (const route of ['/script.js', '/api/send']) assert.match(vhost, new RegExp(`location\\s+=\\s+${route.replace(/[./]/g, '\\$&')}\\s*\\{[^}]*proxy_pass`));
  // Everything else answers 404 unless rendered with UMAMI_APP_OPEN=yes.
  // The HTTPS server's catch-all, after the port 80 redirect's.
  const app = vhost.slice(vhost.lastIndexOf('location / {'));
  assert.match(vhost, /set\s+\$umami_app_open\s+"\$\{UMAMI_APP_OPEN\}"\s*;/);
  assert.match(app, /^location \/ \{\s*if \(\$umami_app_open != "yes"\) \{\s*return 404;/);
  const deploy = withoutComments(read('deploy.sh'));
  assert.match(deploy, /^UMAMI_APP_OPEN=no$/m);
  assert.match(deploy, /render_vhost umami\.conf\.template\s+"\$UMAMI_DOMAIN"\s+UMAMI_DOMAIN UMAMI_APP_OPEN/);
  // Opened only after the login was checked or replaced through Umami's API.
  const opened = deploy.indexOf('UMAMI_APP_OPEN=yes');
  assert.ok(opened > deploy.indexOf('if secure_umami; then'), 'the vhost opens before the login is checked');
  assert.match(deploy, /\/api\/me\/password/);
  // And Umami takes the visitor's address only from the header nginx sets.
  assert.match(withoutComments(read('docker-compose.yml')), /CLIENT_IP_HEADER:\s*x-real-ip/);
});

test('the collector runs as its own account, which owns the clones and reads only its files', () => {
  const deploy = withoutComments(read('deploy.sh'));
  assert.match(deploy, /useradd --system[^\n]*\\?\n?[^\n]*bulwark-collector/);
  assert.match(deploy, /chown -R bulwark-collector:bulwark-collector data\/repos/);
  // Its own variables in collector/.env and the App Store Connect key: readable through the
  // account's group, by nobody else.
  assert.match(deploy, /grep -E '\^\(GITHUB_TOKEN\|[^']*\)=' \.env > collector\/\.env\.new/);
  assert.match(deploy, /chgrp bulwark-collector collector\/\.env\.new\s*\n\s*chmod 640 collector\/\.env\.new/);
  assert.match(deploy, /chgrp bulwark-collector "\$asc_key"\s*\n\s*chmod 640 "\$asc_key"/);
  // The stack's .env is root's alone once the collector reads its own file.
  assert.match(deploy, /chgrp root \.env\s*\n\s*chmod 600 \.env/);
  // A running app started as another account, or with variables from .env, is started anew.
  assert.match(deploy, /needs_new_start "\$name" "\$want"; then[\s\S]*?pm2_clean "\$home" delete "\$name"\s*\n\s*pm2_clean "\$home" start "\$eco"/);
  // All of it before the collector starts.
  const started = deploy.indexOf('deploy_app collector bulwark-dashboard-collector');
  assert.ok(started > 0 && deploy.indexOf('useradd --system') < started && deploy.indexOf('mv -f collector/.env.new collector/.env') < started);
});

test('the apps get no secret through pm2, and pm2\'s saved list is root\'s alone', () => {
  const deploy = withoutComments(read('deploy.sh'));
  // .env is read, not exported, so no command the script runs inherits it.
  assert.doesNotMatch(deploy, /set -a/);
  assert.doesNotMatch(deploy, /^\s*export\s/m);
  // pm2 runs with PATH and HOME only; nothing calls pm2 directly.
  assert.match(deploy, /env -i PATH="\$PATH" HOME="\$home" PM2_HOME="\$PM2_DIR" pm2 "\$@"/);
  for (const line of deploy.split('\n').filter((l) => /\bpm2\s+("\$@"|start|reload|delete|save|describe|pid|jlist|kill|update)\b/.test(l))) {
    assert.match(line, /pm2_clean|env -i PATH="\$PATH" HOME="\$home" PM2_HOME="\$PM2_DIR" pm2/, `pm2 called with the script's environment: ${line.trim()}`);
  }
  // The collector's account has its own home; the saved list is mode 600.
  assert.match(deploy, /deploy_app collector bulwark-dashboard-collector "\$APP_DIR\/data\/repos"/);
  assert.match(deploy, /for f in "\$PM2_DIR"\/dump\.pm2\*; do\s*\n\s*if \[ -e "\$f" \]; then chmod 600 "\$f"; fi/);
  // envsubst gets only the values a template names.
  assert.match(deploy, /env -i PATH="\$PATH" "\$\{values\[@\]\}" envsubst "\$vars"/);
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
