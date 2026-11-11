import fs from 'node:fs';
import crypto from 'node:crypto';
import { pool } from './db.js';
import { env } from './env.js';
import { errorText, log } from './log.js';

const API = 'https://api.appstoreconnect.apple.com';

function jwt(): string {
  const key = fs.readFileSync(env.ascKeyFile, 'utf8');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: env.ascKeyId, typ: 'JWT' })}.${b64({
    iss: env.ascIssuerId, iat: now, exp: now + 10 * 60, aud: 'appstoreconnect-v1',
  })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${sig}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(token: string, path: string): Promise<any> {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  // Up to 200 characters of the answer go into the error, with credentials and keys taken out.
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${errorText(text, [token], 200)}`);
  return JSON.parse(text);
}

export function testflightConfigured(): boolean {
  return Boolean(env.ascKeyFile && env.ascKeyId && env.ascIssuerId && fs.existsSync(env.ascKeyFile));
}

export async function runTestflight(): Promise<void> {
  if (!testflightConfigured()) return;
  const token = jwt();
  const apps = await get(token, `/v1/apps?filter[bundleId]=${encodeURIComponent(env.ascBundleId)}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`testflight: no app with bundle id ${env.ascBundleId}`);

  let ok = 0; let err = 0;
  let next: string | null =
    `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200` +
    '&fields[builds]=version,uploadedDate,expired,preReleaseVersion&include=preReleaseVersion&fields[preReleaseVersions]=version';
  while (next) {
    const page = await get(token, next.startsWith(API) ? next.slice(API.length) : next);
    const versions = new Map<string, string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (page.included ?? []).map((i: any) => [i.id, i.attributes?.version as string]),
    );
    for (const b of page.data ?? []) {
      try {
        const metrics = await get(token, `/v1/builds/${b.id}/metrics/betaBuildUsages`);
        const v = metrics.data?.[0]?.dataPoints?.[0]?.values ?? {};
        const version = versions.get(b.relationships?.preReleaseVersion?.data?.id) ?? null;
        await pool.query(
          `INSERT INTO testflight_builds (build_id, bundle_id, build_number, version, uploaded_at, expired, install_count, session_count, crash_count, feedback_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (build_id) DO UPDATE SET
             version = EXCLUDED.version, uploaded_at = EXCLUDED.uploaded_at, expired = EXCLUDED.expired,
             install_count = EXCLUDED.install_count, session_count = EXCLUDED.session_count,
             crash_count = EXCLUDED.crash_count, feedback_count = EXCLUDED.feedback_count, updated_at = now()`,
          [b.id, env.ascBundleId, b.attributes.version, version, b.attributes.uploadedDate, b.attributes.expired ?? false,
            v.installCount ?? 0, v.sessionCount ?? 0, v.crashCount ?? 0, v.feedbackCount ?? 0],
        );
        await pool.query(
          `INSERT INTO testflight_build_snapshots (build_id, ts, install_count, session_count)
           SELECT $1, now(), $2, $3
           WHERE COALESCE((SELECT install_count FROM testflight_build_snapshots WHERE build_id = $1 ORDER BY ts DESC LIMIT 1), -1) <> $2`,
          [b.id, v.installCount ?? 0, v.sessionCount ?? 0],
        );
        ok++;
      } catch (e) {
        err++;
        log.warn('testflight.build_failed', { build: b.id, err: e instanceof Error ? e.message : String(e) });
      }
    }
    next = page.links?.next ?? null;
  }
  log.info('testflight.done', { ok, err });
}
