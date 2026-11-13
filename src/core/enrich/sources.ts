import { fetchJson } from './http';
import type { McpPackage, SkillsShInfo } from '../../shared/types';

/**
 * skills.sh install counts and partner verdicts. Both endpoints are the undocumented ones the Vercel
 * `skills` CLI itself calls; they may change, so every caller treats a failure as "no data".
 */
export async function skillsShInstalls(name: string, source: string): Promise<number | null> {
  const { data } = await fetchJson<{ skills?: { source: string; skillId: string; installs: number }[] }>(`https://skills.sh/api/search?q=${encodeURIComponent(name)}`);
  const match = data?.skills?.find((s) => s.source.toLowerCase() === source.toLowerCase() && s.skillId.toLowerCase() === name.toLowerCase());
  return match?.installs ?? null;
}

export async function skillsShAudits(source: string, skills: string[]): Promise<Record<string, SkillsShInfo['partners']>> {
  const url = `https://www.skills.sh/tele/audit?source=${encodeURIComponent(source)}&skills=${skills.map(encodeURIComponent).join(',')}`;
  const { data } = await fetchJson<Record<string, SkillsShInfo['partners']>>(url);
  return data ?? {};
}

/** OpenSSF Scorecard. A 404 means the repository is not covered, which is common and not an error. */
export async function scorecard(owner: string, repo: string): Promise<{ score: number; date: string } | null> {
  const { data } = await fetchJson<{ score?: number; date?: string }>(`https://api.scorecard.dev/projects/github.com/${owner}/${repo}`);
  return data && typeof data.score === 'number' ? { score: data.score, date: data.date ?? '' } : null;
}

export async function latestVersion(pkg: McpPackage): Promise<string | null> {
  if (pkg.ecosystem === 'npm') {
    const name = pkg.name.startsWith('@') ? `@${encodeURIComponent(pkg.name.slice(1))}` : encodeURIComponent(pkg.name);
    const { data } = await fetchJson<{ version?: string }>(`https://registry.npmjs.org/${name}/latest`);
    return data?.version ?? null;
  }
  if (pkg.ecosystem === 'pypi') {
    const { data } = await fetchJson<{ info?: { version?: string } }>(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`);
    return data?.info?.version ?? null;
  }
  return null;
}

/** OSV batch query: known vulnerabilities for each package at its pinned (or latest) version. */
export async function osvBatch(queries: { name: string; ecosystem: 'npm' | 'PyPI'; version: string }[]): Promise<{ id: string; summary: string }[][]> {
  if (!queries.length) return [];
  const { data } = await fetchJson<{ results?: { vulns?: { id: string; summary?: string }[] }[] }>('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    body: { queries: queries.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) },
  });
  return (data?.results ?? []).map((r) => (r.vulns ?? []).map((v) => ({ id: v.id, summary: v.summary ?? '' })));
}
