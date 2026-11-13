import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userAgent } from '../enrich/http';
import { mapLimit } from '../util/limit';
import type { SkillRecord } from '../../shared/types';

export interface OriginCandidate {
  owner: string;
  repo: string;
  skillPath: string;
  installs: number | null;
  match: 'exact' | 'similar' | 'different';
  similarity: number;
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, { headers: { 'user-agent': userAgent() }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  return response.text();
}

/** Share of distinct non-empty lines the two files have in common. */
function similarity(a: string, b: string): number {
  const lines = (t: string) => new Set(t.split('\n').map((l) => l.trim()).filter(Boolean));
  const left = lines(a);
  const right = lines(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const line of left) if (right.has(line)) shared++;
  return shared / Math.max(left.size, right.size);
}

/**
 * Looks for where an untracked skill came from: skills.sh search by name, then fetches each candidate's
 * SKILL.md from GitHub (raw content, no API quota) and compares it with the local file.
 */
export async function traceOrigin(skill: SkillRecord): Promise<OriginCandidate[]> {
  const local = await readFile(join(skill.realPath, 'SKILL.md'), 'utf8');
  const search = await fetchText(`https://skills.sh/api/search?q=${encodeURIComponent(skill.folderName)}`);
  const hits = ((search ? (JSON.parse(search) as { skills?: { source: string; skillId: string; installs: number }[] }).skills : []) ?? [])
    .filter((h) => h.skillId.toLowerCase() === skill.folderName.toLowerCase() || h.skillId.toLowerCase() === skill.name.toLowerCase())
    .slice(0, 8);

  const candidates = await mapLimit(hits, 4, async (hit): Promise<OriginCandidate | null> => {
    const [owner, repo] = hit.source.split('/') as [string, string];
    const paths = [`skills/${hit.skillId}`, hit.skillId, `.claude/skills/${hit.skillId}`, `plugins/${hit.skillId}/skills/${hit.skillId}`, ''];
    for (const path of paths) {
      const text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path ? `${path}/` : ''}SKILL.md`);
      if (!text) continue;
      const score = text === local ? 1 : similarity(local, text);
      return { owner, repo, skillPath: path, installs: hit.installs, match: score === 1 ? 'exact' : score >= 0.6 ? 'similar' : 'different', similarity: Math.round(score * 100) / 100 };
    }
    return null;
  });
  return candidates.filter((c): c is OriginCandidate => !!c).sort((a, b) => b.similarity - a.similarity || (b.installs ?? 0) - (a.installs ?? 0));
}
