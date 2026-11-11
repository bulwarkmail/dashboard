import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  prerelease: boolean;      // GitHub prerelease flag or a "-beta.N"-style tag
}

/** The checked content of overrides.json. */
export interface Overrides {
  minimumSupported: string | null;
  severities: Map<string, { severity: Severity; advisory: string | null }>;
}

interface Registry {
  fetchedAt: string;
  latest: string | null;
  minimumSupported: string | null;
  entries: Map<string, VersionEntry>;
}

const OVERRIDES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'overrides.json',
);

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['normal', 'security', 'deprecated']);
const GHSA_ID = /^GHSA(-[0-9a-z]{4}){3}$/;
// The keys the file may hold; any other key (a misspelt one) makes it invalid.
const FILE_KEYS: ReadonlySet<string> = new Set(['_doc', 'minimumSupported', 'severities']);
const ENTRY_KEYS: ReadonlySet<string> = new Set(['severity', 'advisory']);

// Why the answers don't come from overrides.json's current content: the file is missing, can't be
// read or is invalid, or it is valid but the registry has not been rebuilt with it, because GitHub's
// release list could not be fetched since.
type OverridesProblem = 'missing' | 'unreadable' | 'invalid' | 'releases-unavailable';

let current: Registry = empty();
// The last overrides that were valid; null until the first file was read.
let overrides: Overrides | null = null;
// What reading the file found last; null when it was valid.
let fileProblem: Exclude<OverridesProblem, 'releases-unavailable'> | null = null;
// The overrides `current` was built with.
let builtWith: Overrides | null = null;

function empty(): Registry {
  return {
    fetchedAt: new Date(0).toISOString(),
    latest: null,
    minimumSupported: null,
    entries: new Map(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first key named twice in one object of a JSON text (JSON.parse keeps only the last), or null.
 * `text` must be valid JSON.
 */
function keyNamedTwice(text: string): string | null {
  // One entry per open object (its keys) or array (null).
  const open: Array<Set<string> | null> = [];
  let keyNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const keys = open[open.length - 1];
      if (keys && keyNext) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
        keyNext = false;
      }
      i = j;
    } else if (c === '{') {
      open.push(new Set());
      keyNext = true;
    } else if (c === '[') {
      open.push(null);
      keyNext = false;
    } else if (c === '}' || c === ']') {
      open.pop();
      keyNext = false;
    } else if (c === ',') {
      keyNext = open[open.length - 1] != null;
    } else if (c === ':') {
      keyNext = false;
    }
  }
  return null;
}

/**
 * Turns the text of overrides.json into overrides. Throws with the reason when the text is no JSON
 * object, names a key twice in one object, holds a key other than `_doc`, `minimumSupported` and
 * `severities`, `minimumSupported` is no version, or an entry is malformed: its key is no version,
 * it holds a key other than `severity` and `advisory`, its severity is not one of normal, security,
 * deprecated, or its advisory no comma-separated list of GHSA ids.
 */
export function parseOverrides(text: string): Overrides {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('the file holds no JSON object');
  const twice = keyNamedTwice(text);
  if (twice !== null) throw new Error(`key named twice: ${JSON.stringify(twice).slice(0, 40)}`);
  const unknownKey = Object.keys(parsed).find((key) => !FILE_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`unknown key ${JSON.stringify(unknownKey).slice(0, 40)}`);
  const { minimumSupported, severities } = parsed;
  if (minimumSupported !== undefined && (typeof minimumSupported !== 'string' || !parse(normalize(minimumSupported)))) {
    throw new Error('minimumSupported is not a version');
  }
  if (severities !== undefined && !isObject(severities)) throw new Error('severities is not an object');
  const out: Overrides['severities'] = new Map();
  for (const [version, entry] of Object.entries(severities ?? {})) {
    const at = `severities[${JSON.stringify(version).slice(0, 40)}]`;
    if (!parse(version) || version !== normalize(version)) throw new Error(`${at}: the key is not a version`);
    if (!isObject(entry)) throw new Error(`${at} is not an object`);
    const unknownEntryKey = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
    if (unknownEntryKey !== undefined) throw new Error(`${at}: unknown key ${JSON.stringify(unknownEntryKey).slice(0, 40)}`);
    if (typeof entry.severity !== 'string' || !SEVERITIES.has(entry.severity)) {
      throw new Error(`${at}.severity is not one of normal, security, deprecated`);
    }
    const { advisory } = entry;
    if (advisory !== undefined && advisory !== null
      && (typeof advisory !== 'string' || !advisory.split(',').every((id) => GHSA_ID.test(id.trim())))) {
      throw new Error(`${at}.advisory is not a list of GHSA ids`);
    }
    out.set(version, { severity: entry.severity as Severity, advisory: typeof advisory === 'string' ? advisory : null });
  }
  return {
    minimumSupported: typeof minimumSupported === 'string' ? normalize(minimumSupported) : null,
    severities: out,
  };
}

function keepPrevious(problem: OverridesProblem, reason: string, previous: Overrides | null): Overrides {
  log.error(`overrides.${problem}`, {
    path: OVERRIDES_PATH,
    err: reason,
    using: previous ? 'the overrides loaded before' : 'nothing',
  });
  if (!previous) throw new Error(`overrides file ${problem}: ${reason}`);
  return previous;
}

/**
 * The overrides to use after reading overrides.json. `text` is the file's content, or null when the
 * file does not exist. A missing or broken file keeps `previous`; with nothing loaded before (at
 * start) it throws, and the server does not start.
 */
export function nextOverrides(text: string | null, previous: Overrides | null): Overrides {
  if (text === null) return keepPrevious('missing', 'the file does not exist', previous);
  try {
    return parseOverrides(text);
  } catch (err) {
    return keepPrevious('invalid', err instanceof Error ? err.message : String(err), previous);
  }
}

/** The file's text, or null when it does not exist. Throws when it exists but can't be read. */
function readOverridesFile(): string | null {
  try {
    return fs.readFileSync(OVERRIDES_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The overrides to use, and why they are not the file's current content (null when they are). */
function loadOverrides(read: () => string | null, previous: Overrides | null): {
  used: Overrides; problem: Exclude<OverridesProblem, 'releases-unavailable'> | null;
} {
  let text: string | null;
  try {
    text = read();
  } catch (err) {
    return { used: keepPrevious('unreadable', err instanceof Error ? err.message : String(err), previous), problem: 'unreadable' };
  }
  const used = nextOverrides(text, previous);
  // parseOverrides() always returns a new object, so getting `previous` back means the file was not taken.
  return { used, problem: used === previous ? (text === null ? 'missing' : 'invalid') : null };
}

export interface GithubRelease {
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

/** Where refresh() reads from. Tests pass their own; the server uses GitHub and overrides.json. */
export interface RefreshSources {
  releases?: () => Promise<GithubRelease[]>;
  /** The text of overrides.json, or null when it does not exist. */
  overridesText?: () => string | null;
}

export async function refresh(sources: RefreshSources = {}): Promise<void> {
  const { releases: getReleases = fetchReleases, overridesText = readOverridesFile } = sources;
  // Read before GitHub is asked, so a broken file stops the start even when GitHub is down.
  const { used, problem } = loadOverrides(overridesText, overrides);
  overrides = used;
  fileProblem = problem;
  const sevMap = used.severities;

  let releases: GithubRelease[];
  try {
    releases = await getReleases();
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
    const parsed = parse(version);
    if (!parsed) continue;
    const override = sevMap.get(version);
    entries.set(version, {
      version,
      released: r.published_at,
      url: r.html_url,
      title: r.name,
      severity: override?.severity ?? 'normal',
      advisory: override?.advisory ?? null,
      prerelease: r.prerelease || parsed.pre !== null,
    });
  }

  // Apply override-only entries (e.g. retroactively flagging a yanked version
  // even if its GitHub release was deleted).
  for (const [version, override] of sevMap) {
    if (entries.has(version)) continue;
    const parsed = parse(version);
    if (!parsed) continue;
    entries.set(version, {
      version,
      released: null,
      url: null,
      title: null,
      severity: override.severity,
      advisory: override.advisory,
      prerelease: parsed.pre !== null,
    });
  }

  // Latest = highest non-prerelease version that isn't flagged deprecated.
  let latest: string | null = null;
  for (const e of entries.values()) {
    if (e.severity === 'deprecated' || e.prerelease) continue;
    const p = parse(e.version);
    if (!p) continue;
    if (!latest || compare(p, parse(latest)!) > 0) latest = e.version;
  }

  const { minimumSupported } = used;

  current = {
    fetchedAt: new Date().toISOString(),
    latest,
    minimumSupported,
    entries,
  };
  builtWith = used;

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
// Pre-releases (betas) are never offered as updates, not even to someone
// already running a beta: the beta channel updates itself. A beta install is
// told to update once a stable release above it ships (1.11.0 > 1.11.0-beta.2).
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
    if (e.severity === 'deprecated' || e.prerelease) continue;
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

/**
 * What /health shows. `overridesStale` is true while the answers don't come from overrides.json's
 * current content, and `overridesProblem` says why: the file is missing, unreadable or invalid, or
 * it is valid but GitHub's release list could not be fetched since (`releases-unavailable`). The
 * details are in the log, never the file's content.
 */
export function snapshot(): {
  fetchedAt: string; latest: string | null; minimumSupported: string | null; count: number;
  overridesStale: boolean; overridesProblem: OverridesProblem | null;
} {
  const problem: OverridesProblem | null = fileProblem ?? (builtWith !== overrides ? 'releases-unavailable' : null);
  return {
    fetchedAt: current.fetchedAt,
    latest: current.latest,
    minimumSupported: current.minimumSupported,
    count: current.entries.size,
    overridesStale: problem !== null,
    overridesProblem: problem,
  };
}
