// Strict allow-list validator for incoming heartbeats. Anything not listed
// here is silently dropped from the stored payload - we never store
// unexpected fields, even if the client sends them.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_LIKE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][\w.-]+)?$/;
const SHORT_TEXT_RE = /^[\w.+-]{1,64}$/;

const PLATFORMS = new Set(['docker', 'bare', 'k8s', 'unknown']);
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

export interface CleanHeartbeat {
  schema: string;
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

export function validate(input: unknown): CleanHeartbeat | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;

  if (str(o.schema) !== '1') return null;

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
    schema: '1',
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
