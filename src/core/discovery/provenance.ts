import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vercelGlobalLockPaths } from '../paths';
import { readJsonResilient } from '../util/fs';
import type { GitHubRef, Provenance } from '../../shared/types';

/** Parses `owner/repo`, GitHub https and ssh URLs, and `/tree/<ref>/<path>` links. */
export function parseGitHubRef(input: string | undefined): (GitHubRef & { ref?: string; subpath?: string }) | null {
  if (!input) return null;
  const text = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?(?:[?#].*)?$/i.exec(text);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3], subpath: url[4]?.replace(/\/SKILL\.md$/i, '') };
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short && !text.startsWith('.')) return { owner: short[1]!, repo: short[2]! };
  return null;
}

export function repoKey(ref: GitHubRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

interface VercelLockEntry {
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  ref?: string;
  commit?: string;
  skillPath?: string;
  skillName?: string;
  skillFolderHash?: string;
  computedHash?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface LockIndex {
  /** Keyed by lowercased skill name. */
  global: Map<string, VercelLockEntry>;
  globalPath: string | null;
}

/** Reads the Vercel `skills` CLI global lock. Versions before 3 are ignored, as the CLI itself does. */
export async function readVercelGlobalLock(): Promise<LockIndex> {
  for (const path of vercelGlobalLockPaths()) {
    const lock = await readJsonResilient<{ version?: number; skills?: Record<string, VercelLockEntry> }>(path).catch(() => null);
    if (!lock) continue;
    const map = new Map<string, VercelLockEntry>();
    if ((lock.version ?? 0) >= 3 && lock.skills) {
      for (const [name, entry] of Object.entries(lock.skills)) map.set(name.toLowerCase(), entry);
    }
    return { global: map, globalPath: path };
  }
  return { global: new Map(), globalPath: null };
}

/** Project lock `skills-lock.json` (v2): no timestamps, but source and content hash. */
export async function readVercelProjectLock(projectPath: string): Promise<Map<string, VercelLockEntry>> {
  const lock = await readJsonResilient<{ version?: number; skills?: Record<string, VercelLockEntry> }>(join(projectPath, 'skills-lock.json')).catch(() => null);
  const map = new Map<string, VercelLockEntry>();
  if (lock?.skills) for (const [name, entry] of Object.entries(lock.skills)) map.set(name.toLowerCase(), entry);
  return map;
}

export function provenanceFromLock(entry: VercelLockEntry, kind: 'vercel-lock' | 'vercel-project-lock'): Provenance {
  const github = entry.sourceType === 'github' || !entry.sourceType ? parseGitHubRef(entry.sourceUrl ?? entry.source) : null;
  return {
    kind,
    source: entry.source ?? entry.sourceUrl ?? 'unknown',
    github: github ? { owner: github.owner, repo: github.repo } : undefined,
    ref: entry.ref,
    commit: entry.commit,
    skillPath: entry.skillPath,
    treeSha: entry.skillFolderHash,
    url: entry.sourceUrl,
    updatedAt: entry.updatedAt,
  };
}

/** Reads origin URL and HEAD commit from a `.git` folder without spawning git. */
export async function readGitProvenance(dir: string): Promise<Provenance | null> {
  const gitDir = join(dir, '.git');
  let config: string;
  try {
    config = await readFile(join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const origin = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(config)?.[1]?.trim();
  let commit: string | undefined;
  let ref: string | undefined;
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      ref = head.slice(5).replace(/^refs\/heads\//, '');
      commit = (await readFile(join(gitDir, head.slice(5)), 'utf8').catch(() => '')).trim() || undefined;
      if (!commit) {
        const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8').catch(() => '');
        commit = new RegExp(`^([0-9a-f]{40}) ${head.slice(5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(packed)?.[1];
      }
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      commit = head;
    }
  } catch {
    // no HEAD: keep the origin only
  }
  const github = parseGitHubRef(origin);
  return {
    kind: 'git',
    source: github ? `${github.owner}/${github.repo}` : (origin ?? 'local git repository'),
    github: github ? { owner: github.owner, repo: github.repo } : undefined,
    ref,
    commit,
    url: origin,
  };
}

export function provenanceFromFrontmatter(data: Record<string, unknown>): Provenance | null {
  const metadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;
  for (const key of ['repository', 'source', 'homepage', 'url']) {
    const value = data[key] ?? metadata[key];
    const text = typeof value === 'string' ? value : typeof value === 'object' && value && 'url' in value ? String((value as { url: unknown }).url) : undefined;
    const github = parseGitHubRef(text);
    if (github) {
      return {
        kind: 'frontmatter',
        source: `${github.owner}/${github.repo}`,
        github: { owner: github.owner, repo: github.repo },
        ref: github.ref,
        skillPath: github.subpath,
        url: text,
      };
    }
  }
  return null;
}
