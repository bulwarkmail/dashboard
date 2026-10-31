import http from 'node:http';
import { env } from './env.js';
import { log } from './log.js';
import { lookup, refresh, snapshot } from './registry.js';
import { androidSnapshot, latestAndroid, refreshAndroid } from './android.js';

const MAX_VERSION_LEN = 64;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// 302, never 301: the target changes with every release.
function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    'cache-control': 'public, max-age=300',
    'content-length': 0,
  });
  res.end();
}

const server = http.createServer((req, res) => {
  // Intentionally NOT logging req.url, headers, or remote address.
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  // URL parsing without leaking the full URL to logs even on error.
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);

  try {
    if (method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, ...snapshot(), android: androidSnapshot() });
    }

    if ((method === 'GET' || method === 'HEAD') && path === '/android/latest.apk') {
      const rel = latestAndroid();
      if (!rel) return send(res, 503, { error: 'no android release known yet' });
      return redirect(res, rel.apkUrl);
    }

    if ((method === 'GET' || method === 'HEAD') && path === '/android/latest.apk.sha256') {
      const rel = latestAndroid();
      if (!rel?.sha256Url) return send(res, 404, { error: 'not found' });
      return redirect(res, rel.sha256Url);
    }

    if (method === 'GET' && path === '/') {
      const params = new URLSearchParams(query);
      const v = params.get('v');
      if (!v || v.length > MAX_VERSION_LEN) {
        return send(res, 400, { error: 'missing or invalid ?v=' });
      }
      return send(res, 200, lookup(v));
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('handler.failed', { err: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) return send(res, 500, { error: 'server error' });
    res.end();
  }
});

async function main(): Promise<void> {
  // Initial refresh blocks startup so the first response is never empty.
  await Promise.all([refresh(), refreshAndroid()]);

  server.listen(env.port, env.host, () => {
    log.info('version-server listening', { host: env.host, port: env.port });
  });

  setInterval(() => { void refresh(); }, env.refreshIntervalMs);
  setInterval(() => { void refreshAndroid(); }, env.androidRefreshIntervalMs);

  const shutdown = (sig: string): void => {
    log.info('shutting down', { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('fatal', { err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
