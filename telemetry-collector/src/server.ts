import http from 'node:http';
import { env } from './env.js';
import { log } from './log.js';
import { migrate, pool } from './db.js';
import { validate } from './validate.js';
import { runRollup } from './rollup.js';

const MAX_BODY_BYTES = 4 * 1024;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  // Intentionally NOT logging req.url, headers, or remote address.
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];

  try {
    if (method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/v1/heartbeat') {
      const body = await readJson(req);
      const clean = validate(body);
      if (!clean) {
        return send(res, 400, { ok: false });
      }
      const day = clean.ts.slice(0, 10);
      await pool.query(
        `INSERT INTO heartbeats (instance_id, day, payload, received_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (instance_id, day) DO UPDATE SET
           payload = EXCLUDED.payload,
           received_at = now()`,
        [clean.instance_id, day, JSON.stringify(clean)],
      );
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg === 'Payload too large') return send(res, 413, { ok: false });
    log.error('handler.failed', { err: msg });
    if (!res.headersSent) return send(res, 500, { ok: false });
    res.end();
  }
});

async function main(): Promise<void> {
  await migrate();
  server.listen(env.port, env.host, () => {
    log.info('telemetry-collector listening', { host: env.host, port: env.port });
  });

  // Run rollup once at boot, then daily.
  void runRollup();
  setInterval(() => { void runRollup(); }, 24 * 60 * 60 * 1000);

  const shutdown = async (sig: string): Promise<void> => {
    log.info('shutting down', { sig });
    server.close();
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('fatal', { err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
