import { migrate, pool } from './db.js';
import { runSnapshot } from './snapshot.js';
import { runGitScan } from './git.js';
import { env } from './env.js';
import { log } from './log.js';

let snapshotRunning = false;
let gitRunning = false;

async function safeSnapshot(): Promise<void> {
  if (snapshotRunning) { log.warn('snapshot.skipped: already running'); return; }
  snapshotRunning = true;
  try { await runSnapshot(); } catch (e) { log.error('snapshot.exn', { err: String(e) }); }
  finally { snapshotRunning = false; }
}

async function safeGit(): Promise<void> {
  if (gitRunning) { log.warn('git.skipped: already running'); return; }
  gitRunning = true;
  try { await runGitScan(); } catch (e) { log.error('git.exn', { err: String(e) }); }
  finally { gitRunning = false; }
}

async function main(): Promise<void> {
  await migrate();

  if (env.runOnce) {
    log.info('collector: --once mode, running snapshot + git then exiting');
    await safeSnapshot();
    await safeGit();
    await pool.end();
    return;
  }

  log.info('collector: starting', {
    fastIntervalMs: env.fastIntervalMs,
    slowIntervalMs: env.slowIntervalMs,
  });

  // Kick both immediately on boot so the first dashboard load has data.
  await safeSnapshot();
  void safeGit();

  setInterval(safeSnapshot, env.fastIntervalMs);
  setInterval(safeGit, env.slowIntervalMs);

  const shutdown = async (sig: string) => {
    log.info('collector: shutting down', { sig });
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('collector: fatal', { err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
