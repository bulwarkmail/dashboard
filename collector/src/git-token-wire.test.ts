// Where the token travels: the real runGitScan() against a local HTTPS git server that answers as
// github.com. The server records every request's headers and serves repositories through
// git http-backend. It needs a container with no network in which github.com and evil.example resolve
// to 127.0.0.1, run as root (port 443):
//   docker run --network none --add-host github.com:127.0.0.1 --add-host evil.example:127.0.0.1 ...
// Without that mapping this file does nothing, so it never talks to the real github.com.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type http from 'node:http';
import path from 'node:path';

const { lookup } = await import('node:dns/promises');
const mapped = await lookup('github.com').then((a) => a.address === '127.0.0.1', () => false);
if (!mapped) {
  console.log('# skipped: github.com does not resolve to 127.0.0.1 here');
  process.exit(0);
}

process.env.SCAN_HARNESS_HTTPS = '1';
const h = await import('./scan-harness.js');
const { BASIC, TOKEN, work, remote, reposDir, makeRemote, rawGit, row, scanRows } = h;

interface Req { server: 'github' | 'evil'; host: string; method: string; url: string; authorization: string | undefined }
const seen: Req[] = [];
// Per repository: how many info/refs requests were answered, and rules the tests set.
const infoRefs = new Map<string, number>();
const rules = { deny: new Set<string>(), gone: new Set<string>(), denyInfoRefsFrom: new Map<string, number>() };

const keyFile = path.join(work, 'key.pem');
const certFile = path.join(work, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2',
  '-subj', '/CN=github.com', '-addext', 'subjectAltName=DNS:github.com,DNS:evil.example'], { stdio: 'pipe' });
process.env.GIT_SSL_CAINFO = certFile;

function backend(req: http.IncomingMessage, res: http.ServerResponse): void {
  const [pathInfo, query = ''] = (req.url ?? '/').split('?');
  const child = spawn('/usr/lib/git-core/git-http-backend', [], {
    env: {
      PATH: '/usr/bin:/bin', GIT_PROJECT_ROOT: remote, GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: pathInfo, QUERY_STRING: query,
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: String(req.headers['content-length']) } : {}),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  child.stdin.on('error', () => undefined);
  let head = Buffer.alloc(0);
  let sent = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (sent) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
      const at = line.indexOf(':');
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === 'status') status = parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
    sent = true;
  });
  child.on('close', () => { if (!sent) res.writeHead(500); res.end(); });
}

function handler(server: 'github' | 'evil') {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? '/';
    seen.push({ server, host: String(req.headers.host), method: req.method ?? '', url, authorization: req.headers.authorization });
    const repo = /^\/([^/]+\/[^/]+)\.git\//.exec(url)?.[1] ?? '';
    const isInfoRefs = url.includes('/info/refs');
    if (isInfoRefs) infoRefs.set(repo, (infoRefs.get(repo) ?? 0) + 1);
    if (server === 'github') {
      if (repo === 'acme/moved') {
        res.writeHead(301, { location: `https://evil.example:8443${url}` }); res.end(); return;
      }
      if (repo === 'acme/renamed') {
        res.writeHead(301, { location: `https://github.com${url.replace('/acme/renamed.git', '/acme/private.git')}` }); res.end(); return;
      }
      if (rules.gone.has(repo)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Repository not found.'); return; }
      const denyFrom = rules.denyInfoRefsFrom.get(repo);
      const denied = rules.deny.has(repo) || (denyFrom !== undefined && (infoRefs.get(repo) ?? 0) >= denyFrom);
      const needsAuth = repo.startsWith('acme/private') || repo.startsWith('acme/lazy') || repo.startsWith('acme/old');
      if (denied || (needsAuth && req.headers.authorization !== `Basic ${BASIC}`)) {
        // What GitHub answers to a wrong credential, with the sent header repeated in the body to see if it comes back.
        res.writeHead(denied ? 403 : 401, { 'www-authenticate': 'Basic realm="GitHub"', 'content-type': 'text/plain' });
        res.end(`remote: Invalid credentials. You sent ${String(req.headers.authorization)}`);
        return;
      }
    }
    backend(req, res);
  };
}

const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
const github = https.createServer(tls, handler('github'));
const evil = https.createServer(tls, handler('evil'));

function served(name: string, build?: (src: string) => void): void {
  makeRemote(name, 'main', build);
  const bare = path.join(remote, 'acme', `${name}.git`);
  rawGit(bare, 'config', 'uploadpack.allowFilter', 'true');
  rawGit(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  rawGit(bare, 'config', 'http.receivepack', 'false');
}

before(async () => {
  for (const name of ['private', 'public', 'moved', 'denied', 'lazy', 'old1', 'old2', 'old3', 'private-trace']) {
    served(name, (src) => {
      fs.writeFileSync(path.join(src, 'b.ts'), 'one\ntwo\nthree\n');
      rawGit(src, 'add', '.');
      rawGit(src, 'commit', '-q', '-m', 'two');
    });
  }
  await new Promise<void>((resolve) => github.listen(443, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => evil.listen(8443, '127.0.0.1', resolve));
});

after(() => {
  github.close(); evil.close();
  github.closeAllConnections(); evil.closeAllConnections();
  h.cleanup();
});

function filesHolding(dir: string, ...needles: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => { const text = fs.readFileSync(file, 'latin1'); return needles.some((n) => text.includes(n)); })
    .map((file) => path.relative(reposDir, file));
}

function noSecret(text: string, where: string): void {
  assert.ok(!text.includes(TOKEN), `${where} holds the token`);
  assert.ok(!text.includes(BASIC), `${where} holds the base64 credential`);
  assert.ok(!text.includes(Buffer.from(TOKEN).toString('base64')), `${where} holds the token in base64`);
  assert.ok(!/x-access-token/i.test(text), `${where} holds the credential's user name`);
}

function everywhere(result: Awaited<ReturnType<typeof scanRows>>, what: string): void {
  noSecret(JSON.stringify(result.run?.params ?? []), `${what}: collector_runs`);
  noSecret(JSON.stringify(result.calls.map((c) => c.params)), `${what}: a database parameter`);
  noSecret(result.log, `${what}: the log`);
  noSecret(JSON.stringify(result.argv), `${what}: an argument list`);
  assert.deepEqual(filesHolding(reposDir, TOKEN, BASIC, 'x-access-token'), [], `${what}: files under the repos folder`);
}

test('a private repository is cloned, fetched and unpacked with the token as a header to github.com only', async (t) => {
  seen.length = 0;
  const first = await scanRows(t, [row('private', 'main')]);
  assert.equal(first.ok, 1, String(first.error));
  const lines = first.calls.filter((c) => c.sql.startsWith('INSERT INTO loc_snapshots')).reduce((s, c) => s + Number(c.params[3]), 0);
  assert.equal(lines, 4, 'file contents were fetched for the count');
  assert.ok(seen.length >= 4, `${seen.length} requests`);
  for (const r of seen) {
    assert.equal(r.server, 'github');
    assert.equal(r.host, 'github.com');
    assert.equal(r.authorization, `Basic ${BASIC}`, `${r.method} ${r.url} came without the header`);
  }
  t.diagnostic(`first scan: ${seen.map((r) => `${r.method} ${r.url.replace(/\?.*/, '')}`).join(', ')}`);
  everywhere(first, 'first scan');
  seen.length = 0;
  const second = await scanRows(t, [row('private', 'main')]);
  assert.equal(second.ok, 1, String(second.error));
  assert.ok(seen.length >= 1 && seen.every((r) => r.authorization === `Basic ${BASIC}`));
  everywhere(second, 'second scan');
  const config = fs.readFileSync(path.join(reposDir, 'acme', 'private', 'config'), 'utf8');
  assert.match(config, /url = https:\/\/github\.com\/acme\/private\.git\n/);
  assert.ok(!/extraheader/i.test(config), 'the header was written to the clone\'s config');
});

test('without a token no Authorization header is sent', async (t) => {
  t.after(() => { h.env.githubToken = TOKEN; });
  h.env.githubToken = '';
  seen.length = 0;
  const result = await scanRows(t, [row('public', 'main')]);
  assert.equal(result.ok, 1, String(result.error));
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((r) => r.authorization === undefined), 'a header was sent without a token');
});

test('after a redirect from github.com to another host, that host gets no token', async (t) => {
  seen.length = 0;
  const result = await scanRows(t, [row('moved', 'main')]);
  const atEvil = seen.filter((r) => r.server === 'evil');
  t.diagnostic(`ok=${result.ok} error=${result.error}`);
  t.diagnostic(`requests at the other host: ${atEvil.map((r) => `${r.method} ${r.url.replace(/\?.*/, '')} authorization=${r.authorization === undefined ? 'none' : r.authorization === `Basic ${BASIC}` ? 'THE TOKEN' : 'other'}`).join(', ') || 'none'}`);
  assert.ok(atEvil.every((r) => r.authorization === undefined), 'the token was sent to the host github.com redirected to');
  everywhere(result, 'redirect');
});

test('a redirect on github.com itself (a renamed repository) stays on github.com', async (t) => {
  seen.length = 0;
  const result = await scanRows(t, [row('renamed', 'main')]);
  t.diagnostic(`ok=${result.ok} error=${result.error}`);
  assert.ok(seen.every((r) => r.server === 'github'));
  everywhere(result, 'rename');
});

test('failures leave the token out: no repository, a rejected header, a failed fetch, a failed unpack', async (t) => {
  // No repository.
  rules.gone.add('acme/nowhere');
  let result = await scanRows(t, [row('nowhere', 'main')]);
  assert.equal(result.err, 1);
  t.diagnostic(`no repository: ${result.error}`);
  everywhere(result, 'missing');

  // The server refuses the header and repeats it in its answer.
  rules.deny.add('acme/denied');
  result = await scanRows(t, [row('denied', 'main')]);
  assert.equal(result.err, 1);
  t.diagnostic(`rejected: ${result.error}`);
  everywhere(result, 'rejected');

  // An existing clone, then the repository is gone.
  result = await scanRows(t, [row('lazy', 'main')]);
  assert.equal(result.ok, 1, String(result.error));
  rules.gone.add('acme/lazy');
  result = await scanRows(t, [row('lazy', 'main')]);
  assert.equal(result.err, 1);
  t.diagnostic(`fetch failed: ${result.error}`);
  everywhere(result, 'fetch');
  rules.gone.delete('acme/lazy');

  // The fetch works, then the server refuses the request git archive makes for file contents.
  fs.rmSync(path.join(reposDir, 'acme', 'lazy'), { recursive: true, force: true });
  infoRefs.set('acme/lazy', 0);
  rules.denyInfoRefsFrom.set('acme/lazy', 2);
  result = await scanRows(t, [row('lazy', 'main')]);
  t.diagnostic(`unpack failed: ok=${result.ok} ${result.error}`);
  assert.equal(result.err, 1, 'the unpack was expected to fail');
  everywhere(result, 'archive');
  assert.deepEqual(h.leftoverTemp(), [], 'the temp folder was left behind');
  rules.denyInfoRefsFrom.delete('acme/lazy');
});

test('git tracing switched on in the collector\'s environment does not put the header into the log or the run', async (t) => {
  t.after(() => { delete process.env.GIT_CURL_VERBOSE; delete process.env.GIT_TRACE_CURL; delete process.env.GIT_TRACE_REDACT; delete process.env.GIT_TRACE; });
  process.env.GIT_CURL_VERBOSE = '1';
  process.env.GIT_TRACE_CURL = '1';
  process.env.GIT_TRACE = '1';
  process.env.GIT_TRACE_REDACT = '0';
  rules.deny.add('acme/private-trace');
  const result = await scanRows(t, [row('private-trace', 'main')]);
  assert.equal(result.err, 1);
  t.diagnostic(`traced failure: ${result.error}`);
  everywhere(result, 'traced');
});

test('a fresh clone over HTTPS is unpacked the same way every time, with and without a token', async (t) => {
  const rounds = Number(process.env.SCAN_ROUNDS || 25);
  const failures = new Map<string, number>();
  t.after(() => { h.env.githubToken = TOKEN; });
  for (const [name, token] of [['private', TOKEN], ['public', '']] as const) {
    h.env.githubToken = token;
    for (let i = 0; i < rounds; i++) {
      fs.rmSync(path.join(reposDir, 'acme', name), { recursive: true, force: true });
      const result = await scanRows(t, [row(name, 'main')]);
      if (result.ok !== 1) {
        const key = `${name} (${token ? 'token' : 'no token'}): ${String(result.error).replace(/^[^:]*: /, '')}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
  }
  t.diagnostic(`${rounds} fresh clones each; failures: ${JSON.stringify([...failures])}`);
  assert.equal(failures.size, 0, [...failures].map(([k, n]) => `${n} of ${rounds}: ${k}`).join(' | '));
});

function oldClone(name: string, configure: (dir: string) => void): string {
  // What the earlier version left: a bare clone whose remote URL holds the credential.
  const dir = path.join(reposDir, 'acme', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('/usr/bin/git', ['clone', '-q', '--bare', '--filter=blob:none', `file://${path.join(remote, 'acme', `${name}.git`)}`, dir], { stdio: 'pipe' });
  execFileSync('/usr/bin/git', ['--git-dir', dir, 'config', 'remote.origin.url', `https://x-access-token:${TOKEN}@github.com/acme/${name}.git`], { stdio: 'pipe' });
  configure(dir);
  return dir;
}

test('an old clone with the credential in its remote URL is rewritten before git contacts the server', async (t) => {
  const dir = oldClone('old1', () => undefined);
  seen.length = 0;
  const result = await scanRows(t, [row('old1', 'main')]);
  assert.equal(result.ok, 1, String(result.error));
  everywhere(result, 'old clone');
  assert.ok(seen.every((r) => r.authorization === `Basic ${BASIC}`));
  assert.match(fs.readFileSync(path.join(dir, 'config'), 'utf8'), /url = https:\/\/github\.com\/acme\/old1\.git/);
});

test('an old clone whose config can\'t be rewritten is not fetched and its error has no token', async (t) => {
  const dir = oldClone('old2', (d) => fs.writeFileSync(path.join(d, 'config.lock'), ''));
  seen.length = 0;
  const result = await scanRows(t, [row('old2', 'main')]);
  t.diagnostic(`locked config: ok=${result.ok} ${result.error}`);
  assert.equal(result.err, 1);
  noSecret(JSON.stringify(result.run?.params), 'collector_runs');
  noSecret(result.log, 'the log');
  noSecret(JSON.stringify(result.argv), 'an argument list');
  assert.equal(seen.length, 0, 'the server was contacted with the old URL');
  fs.rmSync(path.join(dir, 'config.lock'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('credentials elsewhere in an old clone\'s config stay out of the run, the log and the arguments', async (t) => {
  const dir = oldClone('old3', (d) => {
    const cfg = (...a: string[]) => execFileSync('/usr/bin/git', ['--git-dir', d, 'config', ...a], { stdio: 'pipe' });
    cfg('remote.origin.pushurl', `https://x-access-token:${TOKEN}@github.com/acme/old3.git`);
    cfg('remote.backup.url', `https://x-access-token:${TOKEN}@github.com/acme/old3.git`);
    cfg(`url.https://x-access-token:${TOKEN}@github.com/.insteadOf`, 'https://github.com/');
  });
  seen.length = 0;
  const result = await scanRows(t, [row('old3', 'main')]);
  const config = fs.readFileSync(path.join(dir, 'config'), 'utf8');
  const left = config.split('\n').filter((l) => l.includes(TOKEN)).map((l) => l.trim().replace(TOKEN, '<token>'));
  t.diagnostic(`ok=${result.ok} error=${result.error}`);
  t.diagnostic(`config lines that still hold the token: ${JSON.stringify(left)}`);
  t.diagnostic(`Authorization headers seen: ${[...new Set(seen.map((r) => (r.authorization === `Basic ${BASIC}` ? 'the header' : String(r.authorization))))].join(', ')}`);
  noSecret(JSON.stringify(result.run?.params), 'collector_runs');
  noSecret(result.log, 'the log');
  noSecret(JSON.stringify(result.argv), 'an argument list');
  fs.rmSync(dir, { recursive: true, force: true });
});
