import { posix } from 'node:path';
import { fetchJson, HttpError } from './http';
import { run, which } from '../util/proc';
import type { RepoInfo } from '../../shared/types';

export interface PathQuery {
  /** Folder of the skill inside the repository; empty for the repository root. */
  path: string;
  key: string;
}

export interface PathState {
  treeSha: string | null;
  lastCommit: { oid: string; date: string; message: string } | null;
}

export interface RepoQueryResult {
  info: RepoInfo | null;
  headCommit: string | null;
  paths: Record<string, PathState>;
}

let tokenPromise: Promise<string | null> | null = null;

/**
 * GitHub token, held in memory only: GH_TOKEN or GITHUB_TOKEN, else `gh auth token` when the GitHub
 * CLI is logged in. With a token one GraphQL call answers stars and update checks for 40 repositories.
 */
export function githubToken(): Promise<string | null> {
  tokenPromise ??= (async () => {
    const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (fromEnv) return fromEnv;
    const gh = await which('gh');
    if (!gh) return null;
    const result = await run(gh, ['auth', 'token'], { timeoutMs: 5000 }).catch(() => null);
    const token = result?.code === 0 ? result.stdout.trim() : '';
    return token || null;
  })();
  return tokenPromise;
}

const gqlString = (s: string) => JSON.stringify(s);

/** Batched GraphQL: repository facts plus, per skill folder, its current tree SHA and last commit. */
export async function queryReposGraphql(
  token: string,
  repos: { owner: string; repo: string; paths: PathQuery[] }[],
): Promise<{ results: Map<string, RepoQueryResult>; rateLimit: { remaining: number; limit: number; resetAt: string } | null }> {
  const results = new Map<string, RepoQueryResult>();
  let rateLimit: { remaining: number; limit: number; resetAt: string } | null = null;
  for (let start = 0; start < repos.length; start += 40) {
    const batch = repos.slice(start, start + 40);
    const fields = batch
      .map((r, i) => {
        const pathFields = r.paths
          .slice(0, 40)
          .map((p, j) => {
            const expr = p.path ? `HEAD:${p.path}` : 'HEAD:';
            const history = p.path ? `history(first: 1, path: ${gqlString(p.path)})` : 'history(first: 1)';
            return `t${j}: object(expression: ${gqlString(expr)}) { oid }
              c${j}: defaultBranchRef { target { ... on Commit { ${history} { nodes { oid committedDate messageHeadline } } } } }`;
          })
          .join('\n');
        return `r${i}: repository(owner: ${gqlString(r.owner)}, name: ${gqlString(r.repo)}) {
          stargazerCount pushedAt isArchived description url licenseInfo { spdxId }
          defaultBranchRef { name target { oid } }
          ${pathFields}
        }`;
      })
      .join('\n');
    const query = `query { rateLimit { remaining limit resetAt } ${fields} }`;
    const { data } = await fetchJson<{ data?: Record<string, any>; errors?: { message: string; path?: string[] }[] }>('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}` },
      body: { query },
      timeoutMs: 30_000,
    });
    const payload = data?.data ?? {};
    if (payload.rateLimit) rateLimit = payload.rateLimit;
    batch.forEach((r, i) => {
      const node = payload[`r${i}`];
      const key = `${r.owner}/${r.repo}`.toLowerCase();
      if (!node) {
        results.set(key, { info: null, headCommit: null, paths: {} });
        return;
      }
      const paths: Record<string, PathState> = {};
      r.paths.slice(0, 40).forEach((p, j) => {
        const commit = node[`c${j}`]?.target?.history?.nodes?.[0];
        paths[p.key] = {
          treeSha: node[`t${j}`]?.oid ?? null,
          lastCommit: commit ? { oid: commit.oid, date: commit.committedDate, message: commit.messageHeadline } : null,
        };
      });
      results.set(key, {
        info: {
          key,
          stars: node.stargazerCount ?? 0,
          pushedAt: node.pushedAt ?? null,
          license: node.licenseInfo?.spdxId ?? null,
          archived: !!node.isArchived,
          description: node.description ?? null,
          defaultBranch: node.defaultBranchRef?.name ?? null,
          url: node.url,
          fetchedAt: new Date().toISOString(),
        },
        headCommit: node.defaultBranchRef?.target?.oid ?? null,
        paths,
      });
    });
  }
  return { results, rateLimit };
}

/**
 * Unauthenticated fallback (60 requests an hour): one REST call for repository facts and one contents
 * listing per skill folder's parent, whose entries carry each folder's tree SHA.
 */
export async function queryRepoRest(owner: string, repo: string, paths: PathQuery[], budget: { left: number }): Promise<RepoQueryResult> {
  const key = `${owner}/${repo}`.toLowerCase();
  if (budget.left <= 0) throw new HttpError(429, 'https://api.github.com', 'GitHub rate limit budget for this refresh is used up');
  budget.left--;
  const { data } = await fetchJson<any>(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: 'application/vnd.github+json' } });
  if (!data) return { info: null, headCommit: null, paths: {} };
  const result: RepoQueryResult = {
    info: {
      key,
      stars: data.stargazers_count ?? 0,
      pushedAt: data.pushed_at ?? null,
      license: data.license?.spdx_id ?? null,
      archived: !!data.archived,
      description: data.description ?? null,
      defaultBranch: data.default_branch ?? null,
      url: data.html_url,
      fetchedAt: new Date().toISOString(),
    },
    headCommit: null,
    paths: {},
  };
  const byParent = new Map<string, PathQuery[]>();
  for (const p of paths) {
    const parent = p.path ? posix.dirname(p.path) : '';
    byParent.set(parent === '.' ? '' : parent, [...(byParent.get(parent === '.' ? '' : parent) ?? []), p]);
  }
  for (const [parent, group] of byParent) {
    if (budget.left <= 0) break;
    budget.left--;
    const listing = await fetchJson<{ name: string; sha: string; type: string }[]>(`https://api.github.com/repos/${owner}/${repo}/contents/${parent.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { accept: 'application/vnd.github+json' },
    }).catch(() => ({ data: null }));
    for (const p of group) {
      const entry = Array.isArray(listing.data) ? listing.data.find((e) => e.type === 'dir' && e.name === posix.basename(p.path)) : undefined;
      result.paths[p.key] = { treeSha: entry?.sha ?? null, lastCommit: null };
    }
  }
  return result;
}
