import { env } from './env.js';
import { log } from './log.js';
import { compare, normalize, parse } from './semver.js';

// Newest Android APK of the native app, behind a fixed URL. The release assets
// carry the version and commit in their name (bulwark-mobile-0.1.69-dfaf1f3.apk),
// so GitHub's own releases/latest/download/<name> link cannot point at them.
//
// A release counts only once its APK is attached. The release workflow builds
// the APK after the release is published, so for those minutes the previous
// release keeps being served instead of a 404.

export interface AndroidRelease {
  version: string;
  apkUrl: string;
  sha256Url: string | null;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

const APK_RE = /^bulwark-mobile-.+\.apk$/;

let current: AndroidRelease | null = null;
let fetchedAt = new Date(0).toISOString();

async function fetchReleases(): Promise<GithubRelease[]> {
  const url = `https://api.github.com/repos/${env.androidRepo}/releases?per_page=100`;
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

export async function refreshAndroid(): Promise<void> {
  let releases: GithubRelease[];
  try {
    releases = await fetchReleases();
  } catch (err) {
    log.error('android.github_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return; // keep the previous release on failure
  }

  let best: AndroidRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const version = normalize(r.tag_name);
    const parsed = parse(version);
    if (!parsed || parsed.pre !== null) continue;
    const apk = (r.assets ?? []).find((a) => APK_RE.test(a.name));
    if (!apk) continue;
    if (best && compare(parsed, parse(best.version)!) <= 0) continue;
    const sha = r.assets.find((a) => a.name === `${apk.name}.sha256`);
    best = {
      version,
      apkUrl: apk.browser_download_url,
      sha256Url: sha?.browser_download_url ?? null,
    };
  }

  fetchedAt = new Date().toISOString();
  if (best) current = best;
  log.info('android.refreshed', { latest: current?.version ?? null });
}

export function latestAndroid(): AndroidRelease | null {
  return current;
}

export function androidSnapshot(): { fetchedAt: string; latest: string | null } {
  return { fetchedAt, latest: current?.version ?? null };
}
