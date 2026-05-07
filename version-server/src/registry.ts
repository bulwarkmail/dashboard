import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { log } from './log.js';
import { compare, normalize, parse } from './semver.js';

export type Severity = 'normal' | 'security' | 'deprecated';

export interface VersionEntry {
  version: string;          // normalized semver, no leading "v"
  released: string | null;  // ISO timestamp from GitHub published_at
  url: string | null;       // GitHub release html_url
  title: string | null;     // GitHub release name
  severity: Severity;
  advisory: string | null;  // GHSA identifier when severity = security
}

interface OverridesFile {
  minimumSupported?: string;
  severities?: Record<string, { severity: Severity; advisory?: string }>;
}

interface Registry {
  fetchedAt: string;
  latest: string | null;
  minimumSupported: string | null;
  entries: Map<string, VersionEntry>;
}

const OVERRIDES_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'overrides.json',
);

let current: Registry = empty();

function empty(): Registry {
  return {
    fetchedAt: new Date(0).toISOString(),
    latest: null,
    minimumSupported: null,
    entries: new Map(),
  };
}

function loadOverrides(): OverridesFile {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
    const parsed = JSON.parse(raw) as OverridesFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    log.error('overrides.parse_failed', { err: err instanceof Error ? err.message : String(err) });
    return {};
  }
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

async function fetchReleases(): Promise<GithubRelease[]> {
  const url = `https://api.github.com/repos/${env.githubRepo}/releases?per_page=100`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'bulwark-version-server',
    'x-github-api-version': '2022-11-28',
  };
  if (env.githubToken) headers.authorization = `Bearer ${env.githubToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub releases HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('GitHub releases payload not array');
  return body as GithubRelease[];
}

export async function refresh(): Promise<void> {
  const overrides = loadOverrides();
  const sevMap = overrides.severities ?? {};

  let releases: GithubRelease[];
  try {
    releases = await fetchReleases();
  } catch (err) {
    log.error('refresh.github_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return; // keep previous registry on failure
  }

  const entries = new Map<string, VersionEntry>();
  for (const r of releases) {
    if (r.draft) continue;
    const version = normalize(r.tag_name);
    if (!parse(version)) continue;
    const override = sevMap[version];
    entries.set(version, {
      version,
      released: r.published_at,
      url: r.html_url,
      title: r.name,
      severity: override?.severity ?? 'normal',
      advisory: override?.advisory ?? null,
    });
  }

  // Apply override-only entries (e.g. retroactively flagging a yanked version
  // even if its GitHub release was deleted).
  for (const [version, override] of Object.entries(sevMap)) {
    if (entries.has(version)) continue;
    if (!parse(version)) continue;
    entries.set(version, {
      version,
      released: null,
      url: null,
      title: null,
      severity: override.severity,
      advisory: override.advisory ?? null,
    });
  }

  // Latest = highest non-prerelease version that isn't flagged deprecated.
  let latest: string | null = null;
  for (const e of entries.values()) {
    if (e.severity === 'deprecated') continue;
    const p = parse(e.version);
    if (!p || p.pre !== null) continue;
    if (!latest || compare(p, parse(latest)!) > 0) latest = e.version;
  }

  const minimumSupported = overrides.minimumSupported && parse(normalize(overrides.minimumSupported))
    ? normalize(overrides.minimumSupported)
    : null;

  current = {
    fetchedAt: new Date().toISOString(),
    latest,
    minimumSupported,
    entries,
  };

  log.info('registry.refreshed', {
    versions: entries.size,
    latest,
    minimumSupported,
  });
}

export interface LookupResult {
  schema: 1;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  severity: Severity | 'none' | 'unknown';
  url: string | null;
  advisory: string | null;
  checkedAt: string;
}

// Decision logic:
//   - current below minimumSupported     → "deprecated"
//   - current itself flagged deprecated  → "deprecated"
//   - any newer version with severity=security  → "security" (point url at it)
//   - any newer version (normal)         → "normal" (point url at latest)
//   - else                               → "none"
//
// Unknown current version returns severity="unknown" and updateAvailable=false
// so dev/fork builds don't get a scary banner.
export function lookup(currentRaw: string): LookupResult {
  const currentNormalized = normalize(currentRaw);
  const currentParsed = parse(currentNormalized);
  const reg = current;
  const checkedAt = reg.fetchedAt;

  if (!currentParsed) {
    return {
      schema: 1,
      current: currentNormalized,
      latest: reg.latest,
      updateAvailable: false,
      severity: 'unknown',
      url: null,
      advisory: null,
      checkedAt,
    };
  }

  // Deprecation: by minimum-supported floor.
  if (reg.minimumSupported) {
    const min = parse(reg.minimumSupported);
    if (min && compare(currentParsed, min) < 0) {
      const target = reg.entries.get(reg.latest ?? '');
      return {
        schema: 1,
        current: currentNormalized,
        latest: reg.latest,
        updateAvailable: true,
        severity: 'deprecated',
        url: target?.url ?? null,
        advisory: null,
        checkedAt,
      };
    }
  }

  // Deprecation: by explicit override on the running version.
  const selfEntry = reg.entries.get(currentNormalized);
  if (selfEntry?.severity === 'deprecated') {
    const target = reg.entries.get(reg.latest ?? '');
    return {
      schema: 1,
      current: currentNormalized,
      latest: reg.latest,
      updateAvailable: true,
      severity: 'deprecated',
      url: target?.url ?? null,
      advisory: null,
      checkedAt,
    };
  }

  // Find newer entries.
  let newestSecurity: VersionEntry | null = null;
  let newestNormal: VersionEntry | null = null;
  for (const e of reg.entries.values()) {
    const p = parse(e.version);
    if (!p) continue;
    if (compare(p, currentParsed) <= 0) continue;
    if (e.severity === 'deprecated') continue;
    if (e.severity === 'security') {
      if (!newestSecurity || compare(p, parse(newestSecurity.version)!) > 0) {
        newestSecurity = e;
      }
    } else {
      if (!newestNormal || compare(p, parse(newestNormal.version)!) > 0) {
        newestNormal = e;
      }
    }
  }

  if (newestSecurity) {
    return {
      schema: 1,
      current: currentNormalized,
      latest: reg.latest,
      updateAvailable: true,
      severity: 'security',
      url: newestSecurity.url,
      advisory: newestSecurity.advisory,
      checkedAt,
    };
  }
  if (newestNormal) {
    return {
      schema: 1,
      current: currentNormalized,
      latest: reg.latest,
      updateAvailable: true,
      severity: 'normal',
      url: newestNormal.url,
      advisory: null,
      checkedAt,
    };
  }
  return {
    schema: 1,
    current: currentNormalized,
    latest: reg.latest,
    updateAvailable: false,
    severity: 'none',
    url: null,
    advisory: null,
    checkedAt,
  };
}

export function snapshot(): { fetchedAt: string; latest: string | null; minimumSupported: string | null; count: number } {
  return {
    fetchedAt: current.fetchedAt,
    latest: current.latest,
    minimumSupported: current.minimumSupported,
    count: current.entries.size,
  };
}
