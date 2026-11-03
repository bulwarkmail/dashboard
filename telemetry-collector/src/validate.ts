// Strict allow-list validator for incoming heartbeats.
//
// Schema 1: anything not listed here is silently dropped from the stored
// payload - we never store unexpected fields, even if the client sends them.
//
// Schema 2 (schema 1 plus `errors`, sent only with the instance's separate
// error-count consent): stricter. An unknown field anywhere, a value of the
// wrong shape or a list over its bound rejects the whole heartbeat, so a
// client can't smuggle anything into the error counts.
// https://bulwarkmail.org/docs/legal/privacy/telemetry

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_LIKE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][\w.-]+)?$/;
const SHORT_TEXT_RE = /^[\w.+-]{1,64}$/;

const PLATFORMS = new Set(['docker', 'bare', 'k8s', 'desktop', 'unknown']);
const OS_FAMILIES = new Set(['linux', 'darwin', 'windows', 'unknown']);
const COUNT_BUCKETS = new Set(['0', '1', '2-5', '6-10', '11-50', '51-200', '201+']);

const FEATURE_KEYS = [
  'calendar',
  'contacts',
  'files',
  'extensions',
  'oauth_enabled',
  'smime_enabled',
] as const;

const V1_KEYS = new Set([
  'schema', 'instance_id', 'ts', 'version', 'build', 'platform', 'node_version', 'os_family',
  'stalwart_version', 'features', 'counts', 'uptime_days',
]);
const COUNT_KEYS = new Set(['accounts', 'accounts_active_7d', 'extensions_installed', 'themes_installed']);
const ERROR_KEYS = new Set(['name', 'fingerprint', 'frames', 'version', 'count', 'days', 'message']);
const FRAME_KEYS = new Set(['path', 'line', 'col', 'debug_id']);

/** Bounds of schema 2. */
export const MAX_ERRORS = 50;
export const MAX_FRAMES = 5;

const ERROR_NAME_RE = /^[A-Za-z_$][\w$]{0,63}$/;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
// A bundle file of Bulwark without origin: /_next/static/... or /.next/server/...,
// or the desktop app's main process: /desktop/...
const FRAME_PATH_RE = /^\/(?:_next\/static|\.next\/server|desktop)\/[\w./()[\]@+~-]{1,200}$/;
// Bulwark's fixed error codes: `serverFail`, `Email/set: overQuota`, `http:503`.
const ERROR_CODE_RE = /^(?:(?:[A-Z][A-Za-z]{0,40}\/[a-z][A-Za-z]{0,40}: )?[a-z][A-Za-z]{1,40}|http:\d{3})$/;

export interface CleanHeartbeat {
  schema: '1';
  instance_id: string;
  ts: string;
  version: string;
  build: string | null;
  platform: string;
  node_version: string | null;
  os_family: string;
  stalwart_version: string | null;
  features: Record<(typeof FEATURE_KEYS)[number], boolean>;
  counts: {
    accounts: string;
    accounts_active_7d: string;
    extensions_installed: number;
    themes_installed: number;
  };
  uptime_days: number;
}

export interface CleanErrorFrame {
  path: string;
  line: number | null;
  col: number | null;
  debug_id: string | null;
}

export interface CleanError {
  name: string;
  fingerprint: string;
  frames: CleanErrorFrame[];
  version: string;
  count: string;
  days: number;
  message: string | null;
}

export interface CleanHeartbeatV2 extends Omit<CleanHeartbeat, 'schema'> {
  schema: '2';
  errors: CleanError[];
}

function str(value: unknown, re?: RegExp): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 200) return null;
  if (re && !re.test(value)) return null;
  return value;
}

function bool(value: unknown): boolean {
  return value === true;
}

function smallInt(value: unknown, max = 100000): number {
  if (typeof value !== 'number') return 0;
  if (!Number.isFinite(value)) return 0;
  const n = Math.max(0, Math.min(max, Math.trunc(value)));
  return n;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(o: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(o).every((key) => allowed.has(key));
}

function v1Fields(o: Record<string, unknown>): Omit<CleanHeartbeat, 'schema'> | null {
  const instance_id = str(o.instance_id, UUID_RE);
  if (!instance_id) return null;

  // Only the day is kept (UTC midnight); the time of day is dropped.
  const sent = typeof o.ts === 'string' && !Number.isNaN(Date.parse(o.ts))
    ? new Date(o.ts)
    : new Date();
  const ts = `${sent.toISOString().slice(0, 10)}T00:00:00.000Z`;

  const version = str(o.version, SEMVER_LIKE_RE);
  if (!version) return null;

  const platform = (typeof o.platform === 'string' && PLATFORMS.has(o.platform))
    ? o.platform
    : 'unknown';
  const os_family = (typeof o.os_family === 'string' && OS_FAMILIES.has(o.os_family))
    ? o.os_family
    : 'unknown';

  const featuresIn = (o.features && typeof o.features === 'object')
    ? (o.features as Record<string, unknown>)
    : {};
  const features = {} as CleanHeartbeat['features'];
  for (const k of FEATURE_KEYS) features[k] = bool(featuresIn[k]);

  const countsIn = (o.counts && typeof o.counts === 'object')
    ? (o.counts as Record<string, unknown>)
    : {};
  const accBucket = typeof countsIn.accounts === 'string' && COUNT_BUCKETS.has(countsIn.accounts)
    ? countsIn.accounts : '0';
  const activeBucket = typeof countsIn.accounts_active_7d === 'string' && COUNT_BUCKETS.has(countsIn.accounts_active_7d)
    ? countsIn.accounts_active_7d : '0';

  return {
    instance_id,
    ts,
    version,
    build: str(o.build, SHORT_TEXT_RE),
    platform,
    node_version: str(o.node_version, SEMVER_LIKE_RE),
    os_family,
    stalwart_version: str(o.stalwart_version, SEMVER_LIKE_RE),
    features,
    counts: {
      accounts: accBucket,
      accounts_active_7d: activeBucket,
      extensions_installed: smallInt(countsIn.extensions_installed, 1000),
      themes_installed: smallInt(countsIn.themes_installed, 1000),
    },
    uptime_days: smallInt(o.uptime_days, 365),
  };
}

function position(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : undefined;
}

function validFrame(input: unknown): CleanErrorFrame | null {
  if (!isObject(input) || !onlyKeys(input, FRAME_KEYS)) return null;
  const path = str(input.path, FRAME_PATH_RE);
  const line = position(input.line);
  const col = position(input.col);
  const debug_id = input.debug_id === null ? null : str(input.debug_id, UUID_RE);
  if (!path || line === undefined || col === undefined || (input.debug_id !== null && !debug_id)) return null;
  return { path, line, col, debug_id: debug_id ? debug_id.toLowerCase() : null };
}

function validError(input: unknown): CleanError | null {
  if (!isObject(input) || !onlyKeys(input, ERROR_KEYS)) return null;
  const name = str(input.name, ERROR_NAME_RE);
  const fingerprint = str(input.fingerprint, FINGERPRINT_RE);
  const version = str(input.version, SEMVER_LIKE_RE);
  const count = typeof input.count === 'string' && COUNT_BUCKETS.has(input.count) && input.count !== '0' ? input.count : null;
  const days = typeof input.days === 'number' && Number.isInteger(input.days) && input.days >= 1 && input.days <= 7 ? input.days : null;
  if (!name || !fingerprint || !version || !count || !days) return null;
  if (!Array.isArray(input.frames) || input.frames.length > MAX_FRAMES) return null;
  const frames: CleanErrorFrame[] = [];
  for (const raw of input.frames) {
    const frame = validFrame(raw);
    if (!frame) return null;
    frames.push(frame);
  }
  let message: string | null = null;
  if ('message' in input) {
    message = str(input.message, ERROR_CODE_RE);
    if (!message) return null;
  }
  return { name, fingerprint, frames, version, count, days, message };
}

function validateV2(o: Record<string, unknown>): CleanHeartbeatV2 | null {
  const allowed = new Set([...V1_KEYS, 'errors']);
  if (!onlyKeys(o, allowed)) return null;
  if (isObject(o.features) && !onlyKeys(o.features, new Set(FEATURE_KEYS))) return null;
  if (isObject(o.counts) && !onlyKeys(o.counts, COUNT_KEYS)) return null;
  const base = v1Fields(o);
  if (!base) return null;
  if (!Array.isArray(o.errors) || o.errors.length > MAX_ERRORS) return null;
  const errors: CleanError[] = [];
  const seen = new Set<string>();
  for (const raw of o.errors) {
    const error = validError(raw);
    if (!error) return null;
    const key = `${error.fingerprint}|${error.version}`;
    if (seen.has(key)) return null;
    seen.add(key);
    errors.push(error);
  }
  return { schema: '2', ...base, errors };
}

export interface CleanErrorBatch {
  instance_id: string;
  /** The UTC day the counts are for. */
  day: string;
  errors: CleanError[];
}

const BATCH_KEYS = new Set(['schema', 'instance_id', 'day', 'errors']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An instant error-count batch (POST /v1/errors): the current UTC day's
 * errors of one instance, the ones new or in a higher count bucket since
 * its last batch. As strict as schema 2: an unknown field, a bad value or a
 * day other than today or yesterday (a batch sent just after midnight)
 * rejects it.
 */
export function validateErrorBatch(input: unknown, now = Date.now()): CleanErrorBatch | null {
  if (!isObject(input) || !onlyKeys(input, BATCH_KEYS) || input.schema !== '1') return null;
  const instance_id = str(input.instance_id, UUID_RE);
  const day = str(input.day, DAY_RE);
  if (!instance_id || !day) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (day !== today && day !== yesterday) return null;
  if (!Array.isArray(input.errors) || input.errors.length === 0 || input.errors.length > MAX_ERRORS) return null;
  const errors: CleanError[] = [];
  const seen = new Set<string>();
  for (const raw of input.errors) {
    const error = validError(raw);
    if (!error) return null;
    const key = `${error.fingerprint}|${error.version}`;
    if (seen.has(key)) return null;
    seen.add(key);
    errors.push(error);
  }
  return { instance_id: instance_id.toLowerCase(), day, errors };
}

export function validate(input: unknown): CleanHeartbeat | CleanHeartbeatV2 | null {
  if (!isObject(input)) return null;
  const schema = str(input.schema);
  if (schema === '1') {
    const base = v1Fields(input);
    return base ? { schema: '1', ...base } : null;
  }
  if (schema === '2') return validateV2(input);
  return null;
}
