import { Octokit } from '@octokit/rest';
import { env } from './env.js';
import { log } from './log.js';

export const octokit = new Octokit({
  auth: env.githubToken,
  userAgent: 'bulwark-dashboard-collector/0.1',
  request: { retries: 2, retryAfter: 30 },
});

export interface RepoLite {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  archived: boolean;
  private: boolean;
  language: string | null;
  description: string | null;
  homepage: string | null;
  createdAt: string | null;
  pushedAt: string | null;
  stars: number;
  watchers: number;
  forks: number;
  openIssues: number;     // includes PRs in GitHub's counter
  subscribers: number;
  sizeKb: number;
}

export async function listOrgRepos(org: string): Promise<RepoLite[]> {
  const out: RepoLite[] = [];
  for await (const page of octokit.paginate.iterator(octokit.repos.listForOrg, {
    org,
    type: 'all',
    per_page: 100,
  })) {
    for (const r of page.data) {
      out.push({
        id: r.full_name,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch ?? null,
        archived: r.archived ?? false,
        private: r.private,
        language: r.language ?? null,
        description: r.description ?? null,
        homepage: r.homepage ?? null,
        createdAt: r.created_at ?? null,
        pushedAt: r.pushed_at ?? null,
        stars: r.stargazers_count ?? 0,
        watchers: r.watchers_count ?? 0,
        forks: r.forks_count ?? 0,
        openIssues: r.open_issues_count ?? 0,
        subscribers: 0,
        sizeKb: r.size ?? 0,
      });
    }
  }
  log.info('github.listOrgRepos', { org, count: out.length });
  return out;
}

// open_issues_count includes PRs. Fetch open PR count separately.
export async function countOpenPullRequests(owner: string, repo: string): Promise<number> {
  // Cheaper than paginating through PRs: search API.
  const q = `repo:${owner}/${repo} is:pr is:open`;
  const res = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
  return res.data.total_count;
}

export async function fetchSubscribers(owner: string, repo: string): Promise<number> {
  const res = await octokit.repos.get({ owner, repo });
  return res.data.subscribers_count ?? 0;
}

export interface TrafficDay {
  day: string; // ISO date
  count: number;
  uniques: number;
}

export async function fetchTrafficViews(owner: string, repo: string): Promise<TrafficDay[]> {
  try {
    const res = await octokit.repos.getViews({ owner, repo, per: 'day' });
    return res.data.views.map((v) => ({
      day: v.timestamp.slice(0, 10),
      count: v.count,
      uniques: v.uniques,
    }));
  } catch (err) {
    log.warn('github.fetchTrafficViews failed', { repo: `${owner}/${repo}`, err: String(err) });
    return [];
  }
}

export async function fetchTrafficClones(owner: string, repo: string): Promise<TrafficDay[]> {
  try {
    const res = await octokit.repos.getClones({ owner, repo, per: 'day' });
    return res.data.clones.map((c) => ({
      day: c.timestamp.slice(0, 10),
      count: c.count,
      uniques: c.uniques,
    }));
  } catch (err) {
    log.warn('github.fetchTrafficClones failed', { repo: `${owner}/${repo}`, err: String(err) });
    return [];
  }
}

export interface PathRow { path: string; title: string; count: number; uniques: number; }
export interface ReferrerRow { referrer: string; count: number; uniques: number; }

export async function fetchTopPaths(owner: string, repo: string): Promise<PathRow[]> {
  try {
    const res = await octokit.repos.getTopPaths({ owner, repo });
    return res.data.map((r) => ({
      path: r.path,
      title: r.title,
      count: r.count,
      uniques: r.uniques,
    }));
  } catch {
    return [];
  }
}

export async function fetchTopReferrers(owner: string, repo: string): Promise<ReferrerRow[]> {
  try {
    const res = await octokit.repos.getTopReferrers({ owner, repo });
    return res.data.map((r) => ({
      referrer: r.referrer,
      count: r.count,
      uniques: r.uniques,
    }));
  } catch {
    return [];
  }
}

export interface ReleaseRow {
  releaseId: number;
  tag: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  downloads: number;
}

export async function fetchReleases(owner: string, repo: string): Promise<ReleaseRow[]> {
  const out: ReleaseRow[] = [];
  try {
    for await (const page of octokit.paginate.iterator(octokit.repos.listReleases, {
      owner,
      repo,
      per_page: 100,
    })) {
      for (const r of page.data) {
        const downloads = (r.assets ?? []).reduce((sum, a) => sum + (a.download_count ?? 0), 0);
        out.push({
          releaseId: r.id,
          tag: r.tag_name,
          name: r.name ?? null,
          draft: r.draft,
          prerelease: r.prerelease,
          publishedAt: r.published_at ?? null,
          downloads,
        });
      }
    }
  } catch (err) {
    log.warn('github.fetchReleases failed', { repo: `${owner}/${repo}`, err: String(err) });
  }
  return out;
}
