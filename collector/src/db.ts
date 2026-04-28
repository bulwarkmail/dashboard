import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { env } from './env.js';
import { log } from './log.js';

export const pool = new pg.Pool({
  host: env.pgHost,
  port: env.pgPort,
  user: env.pgUser,
  password: env.pgPassword,
  database: env.pgDatabase,
  max: 4,
});

export async function migrate(): Promise<void> {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sqlPath = path.resolve(here, 'schema.sql');
  // After tsc compile, schema.sql sits next to the .js files only if we copy it.
  // Fall back to source location for `npm run dev`.
  const sql = fs.existsSync(sqlPath)
    ? fs.readFileSync(sqlPath, 'utf8')
    : fs.readFileSync(path.resolve(here, '..', 'src', 'schema.sql'), 'utf8');
  await pool.query(sql);
  log.info('db.migrate: schema applied');
}
