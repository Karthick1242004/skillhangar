import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { githubToken, queryRepoRest, queryReposGraphql, type PathQuery, type RepoQueryResult } from './github';
import { latestVersion, osvBatch, scorecard, skillsShAudits, skillsShInstalls } from './sources';
import { loadTrending, type TrendingIndex } from './trending';
import { dataPaths } from '../paths';
import { writeFileAtomic } from '../util/fs';
import { mapLimit } from '../util/limit';
import type { Enrichment, Inventory, SkillRecord, UpdateInfo } from '../../shared/types';

const EMPTY: Enrichment = {
  enabled: false,
  fetchedAt: null,
  repos: {},
  trending: {},
  trendingIndexedThrough: null,
  skillsSh: {},
  scorecards: {},
  updates: {},
  packages: {},
  errors: [],
  rateLimit: null,
};

/** The folder of a skill inside its repository, from a lock's `skillPath` (which may name SKILL.md itself). */
export function skillFolder(skillPath: string | undefined): string | undefined {
  if (!skillPath) return undefined;
  const trimmed = skillPath.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return /(^|\/)SKILL\.md$/i.test(trimmed) ? posix.dirname(trimmed).replace(/^\.$/, '') : trimmed;
}

export class EnrichmentService {
  private state: Enrichment = structuredClone(EMPTY);
  private loaded = false;

  async get(enabled: boolean): Promise<Enrichment> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.state = { ...structuredClone(EMPTY), ...(JSON.parse(await readFile(dataPaths.cache('enrichment.json'), 'utf8')) as Enrichment) };
      } catch {
        // first run
      }
      this.applyTrending(await loadTrending());
    }
    return { ...this.state, enabled };
  }

  applyTrending(index: TrendingIndex): void {
    this.state.trendingIndexedThrough = index.through;
    this.state.trending = {};
    for (const key of Object.keys(this.state.repos)) {
      const dates = index.repos[key];
      if (dates?.length) this.state.trending[key] = dates;
    }
  }

  async refresh(inventory: Inventory, onProgress: (done: number, total: number) => void): Promise<Enrichment> {
    await this.get(true);
    const errors: string[] = [];
    const skills = inventory.skills.filter((s) => s.provenance?.github);

    // 1. GitHub: repository facts and per-folder tree SHAs for update checks.
    const byRepo = new Map<string, { owner: string; repo: string; paths: PathQuery[] }>();
    for (const s of skills) {
      const gh = s.provenance!.github!;
      const key = `${gh.owner}/${gh.repo}`.toLowerCase();
      const entry = byRepo.get(key) ?? { owner: gh.owner, repo: gh.repo, paths: [] };
      const folder = s.provenance!.kind === 'git' ? '' : skillFolder(s.provenance!.skillPath);
      if (folder !== undefined && !entry.paths.some((p) => p.key === s.id)) entry.paths.push({ path: folder, key: s.id });
      byRepo.set(key, entry);
    }
    for (const p of inventory.plugins) {
      if (p.marketplaceRepo && /^[\w.-]+\/[\w.-]+$/.test(p.marketplaceRepo)) {
        const [owner, repo] = p.marketplaceRepo.split('/') as [string, string];
        const key = p.marketplaceRepo.toLowerCase();
        if (!byRepo.has(key)) byRepo.set(key, { owner, repo, paths: [] });
      }
    }
    const repoList = [...byRepo.values()];
    const total = 4;
    onProgress(0, total);

    let results = new Map<string, RepoQueryResult>();
    try {
      const token = await githubToken();
      if (token) {
        const out = await queryReposGraphql(token, repoList);
        results = out.results;
        this.state.rateLimit = out.rateLimit;
      } else {
        const budget = { left: 50 };
        await mapLimit(repoList, 4, async (r) => {
          try {
            results.set(`${r.owner}/${r.repo}`.toLowerCase(), await queryRepoRest(r.owner, r.repo, r.paths, budget));
          } catch (error) {
            errors.push(`GitHub ${r.owner}/${r.repo}: ${(error as Error).message}`);
          }
        });
        if (budget.left <= 0) errors.push('Without a GitHub login only part of the repositories were checked (60 requests an hour). Run `gh auth login` for full results.');
      }
    } catch (error) {
      errors.push(`GitHub: ${(error as Error).message}`);
    }
    for (const [key, result] of results) if (result.info) this.state.repos[key] = result.info;
    this.state.updates = computeUpdates(inventory.skills, results, this.state.updates);
    onProgress(1, total);

    // 2. skills.sh install counts and partner verdicts.
    const shTargets = new Map<string, { source: string; name: string }>();
    for (const s of skills) {
      const source = `${s.provenance!.github!.owner}/${s.provenance!.github!.repo}`;
      shTargets.set(`${source}/${s.folderName}`.toLowerCase(), { source, name: s.folderName });
    }
    // skills.sh allows 30 searches a minute. Counts change slowly, so each is cached for a week, at most
    // 25 are fetched per refresh (the rest follow on later refreshes), and the first 429 stops the batch.
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const due = [...shTargets.entries()]
      .filter(([key]) => {
        const at = this.state.skillsSh[key]?.fetchedAt;
        return !at || Date.now() - Date.parse(at) > WEEK;
      })
      .slice(0, 25);
    let limited = false;
    await mapLimit(due, 3, async ([key, t]) => {
      if (limited) return;
      try {
        const installs = await skillsShInstalls(t.name, t.source);
        this.state.skillsSh[key] = { installs, partners: this.state.skillsSh[key]?.partners ?? {}, fetchedAt: new Date().toISOString() };
      } catch (error) {
        if ((error as { status?: number }).status === 429) limited = true;
        if (!errors.some((e) => e.startsWith('skills.sh'))) errors.push(limited ? 'skills.sh rate limit reached; the remaining install counts load on the next refresh.' : `skills.sh search: ${(error as Error).message}`);
      }
    });
    const remaining = [...shTargets.keys()].filter((key) => !this.state.skillsSh[key]?.fetchedAt).length;
    if (remaining && !limited) errors.push(`${remaining} skills.sh install counts load on later refreshes (30 requests a minute).`);
    const bySource = new Map<string, string[]>();
    for (const t of shTargets.values()) bySource.set(t.source, [...(bySource.get(t.source) ?? []), t.name]);
    await mapLimit([...bySource.entries()], 4, async ([source, names]) => {
      try {
        const audits = await skillsShAudits(source, names);
        for (const [name, partners] of Object.entries(audits)) {
          const key = `${source}/${name}`.toLowerCase();
          this.state.skillsSh[key] = { ...this.state.skillsSh[key], installs: this.state.skillsSh[key]?.installs ?? null, partners };
        }
      } catch (error) {
        if (!errors.some((e) => e.startsWith('skills.sh audit'))) errors.push(`skills.sh audit: ${(error as Error).message}`);
      }
    });
    onProgress(2, total);

    // 3. OpenSSF Scorecard per repository.
    await mapLimit(repoList, 6, async (r) => {
      const key = `${r.owner}/${r.repo}`.toLowerCase();
      try {
        this.state.scorecards[key] = await scorecard(r.owner, r.repo);
      } catch (error) {
        if (!errors.some((e) => e.startsWith('Scorecard'))) errors.push(`Scorecard: ${(error as Error).message}`);
      }
    });
    onProgress(3, total);

    // 4. MCP packages: newest version and known vulnerabilities.
    const packages = new Map(inventory.mcp.filter((m) => m.package && m.package.ecosystem !== 'docker').map((m) => [`${m.package!.ecosystem}:${m.package!.name}`, m.package!]));
    const latest = await mapLimit([...packages.entries()], 6, async ([key, pkg]) => {
      try {
        return [key, await latestVersion(pkg)] as const;
      } catch (error) {
        errors.push(`${pkg.name}: ${(error as Error).message}`);
        return [key, null] as const;
      }
    });
    const osvQueries = [...packages.entries()]
      .map(([key, pkg]) => ({ key, name: pkg.name, ecosystem: pkg.ecosystem === 'npm' ? ('npm' as const) : ('PyPI' as const), version: pkg.version && pkg.pinned ? pkg.version : (latest.find(([k]) => k === key)?.[1] ?? '') }))
      .filter((q) => q.version);
    let vulns: { id: string; summary: string }[][] = [];
    try {
      vulns = await osvBatch(osvQueries);
    } catch (error) {
      errors.push(`OSV: ${(error as Error).message}`);
    }
    for (const [key, version] of latest) {
      const index = osvQueries.findIndex((q) => q.key === key);
      this.state.packages[key] = { key, latest: version, vulns: index >= 0 ? (vulns[index] ?? []) : [], fetchedAt: new Date().toISOString() };
    }
    onProgress(4, total);

    this.applyTrending(await loadTrending());
    this.state.errors = errors;
    this.state.fetchedAt = new Date().toISOString();
    await writeFileAtomic(dataPaths.cache('enrichment.json'), JSON.stringify(this.state));
    return { ...this.state, enabled: true };
  }
}

function computeUpdates(skills: SkillRecord[], results: Map<string, RepoQueryResult>, previous: Record<string, UpdateInfo>): Record<string, UpdateInfo> {
  const updates: Record<string, UpdateInfo> = {};
  for (const s of skills) {
    const p = s.provenance;
    if (!p) {
      updates[s.id] = { skillId: s.id, state: 'untracked', reason: 'No recorded source. Use "Trace origin" to find one.' };
      continue;
    }
    if (p.kind === 'plugin') {
      updates[s.id] = { skillId: s.id, state: 'unknown', reason: 'Updated with its plugin.' };
      continue;
    }
    if (p.kind === 'frontmatter') {
      updates[s.id] = { skillId: s.id, state: 'untracked', reason: 'The source is named in the frontmatter, but no installer recorded a version.' };
      continue;
    }
    const result = p.github ? results.get(`${p.github.owner}/${p.github.repo}`.toLowerCase()) : undefined;
    if (!result) {
      updates[s.id] = previous[s.id] ?? { skillId: s.id, state: 'unknown', reason: 'Not checked yet.' };
      continue;
    }
    if (p.kind === 'git') {
      updates[s.id] = !result.headCommit || !p.commit
        ? { skillId: s.id, state: 'unknown', reason: 'Could not read the commit.' }
        : { skillId: s.id, state: result.headCommit === p.commit ? 'up-to-date' : 'available', latest: result.headCommit };
      continue;
    }
    const path = result.paths[s.id];
    if (!path?.treeSha) {
      updates[s.id] = { skillId: s.id, state: 'unknown', reason: 'The skill folder was not found upstream; it may have moved or been deleted.' };
      continue;
    }
    if (!p.treeSha) {
      updates[s.id] = { skillId: s.id, state: 'unknown', reason: 'The installer did not record a folder hash to compare.' };
      continue;
    }
    updates[s.id] = {
      skillId: s.id,
      state: path.treeSha === p.treeSha ? 'up-to-date' : 'available',
      latest: path.treeSha,
      latestDate: path.lastCommit?.date,
      latestMessage: path.lastCommit?.message,
    };
  }
  return updates;
}
