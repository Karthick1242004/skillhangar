import { createWriteStream } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gitTreeSha } from './gittree';
import { runStaticAudit } from '../audit/static';
import { parseSkillFile, descriptionOf, stringField } from '../discovery/frontmatter';
import { parseGitHubRef } from '../discovery/provenance';
import { githubToken } from '../enrich/github';
import { userAgent } from '../enrich/http';
import { dataPaths } from '../paths';
import { TreeHasher, VENDORED_DIRS, walkTree } from '../tree';
import { copyDir, ensureDir, exists, isDirectory, isInside, safeReaddir, stripEscapingSymlinks, writeFileAtomic } from '../util/fs';
import { newId } from '../util/ids';
import { run, which } from '../util/proc';
import type { QuarantineItem, QuarantineSkill, SourceSpec } from '../../shared/types';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;

export interface QuarantineSkillInternal extends QuarantineSkill {
  dir: string;
  treeSha: string;
}

export interface QuarantineRecord extends Omit<QuarantineItem, 'skills'> {
  dir: string;
  skills: QuarantineSkillInternal[];
}

export class SourceError extends Error {}

/**
 * Accepts a GitHub URL (repository, tree or blob link), `owner/repo`, `owner/repo@skill` (the skills CLI
 * form), `owner/repo/path/to/skill`, a skills.sh page URL, or a local folder path.
 */
export function resolveSource(input: string): SourceSpec {
  const text = input.trim();
  if (!text) throw new SourceError('Enter a GitHub repository, a skills.sh link or a folder path.');
  if (/^(\/|~\/|\.{1,2}\/|[a-zA-Z]:[\\/])/.test(text)) {
    return { kind: 'local', path: resolve(text.replace(/^~(?=\/)/, homedir())) };
  }
  const skillsSh = /^https?:\/\/(?:www\.)?skills\.sh\/([\w.-]+)\/([\w.-]+)(?:\/([\w.-]+))?\/?$/.exec(text);
  if (skillsSh) return { kind: 'github', owner: skillsSh[1]!, repo: skillsSh[2]!, skill: skillsSh[3] };
  const at = /^([\w.-]+)\/([\w.-]+)@([\w.-]+)$/.exec(text);
  if (at) return { kind: 'github', owner: at[1]!, repo: at[2]!, skill: at[3] };
  const deep = /^([\w.-]+)\/([\w.-]+)\/(.+)$/.exec(text);
  if (deep && !text.includes('://') && !text.startsWith('github.com')) return { kind: 'github', owner: deep[1]!, repo: deep[2]!, subpath: deep[3]!.replace(/\/SKILL\.md$/i, '') };
  const gh = parseGitHubRef(text);
  if (gh) return { kind: 'github', owner: gh.owner, repo: gh.repo, ref: gh.ref, subpath: gh.subpath };
  throw new SourceError(`Could not read "${text}" as a GitHub repository, skills.sh link or folder path.`);
}

async function resolveCommit(owner: string, repo: string, ref: string | undefined): Promise<string> {
  const token = await githubToken();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? 'HEAD')}`, {
    headers: { accept: 'application/vnd.github.sha', 'user-agent': userAgent(), ...(token ? { authorization: `bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404 || response.status === 422) throw new SourceError(`${owner}/${repo}${ref ? ` at ${ref}` : ''} was not found on GitHub, or it is private.`);
  if (!response.ok) throw new SourceError(`GitHub answered ${response.status} while resolving ${owner}/${repo}.`);
  const sha = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new SourceError('GitHub returned an unexpected commit id.');
  return sha;
}

/** Downloads the tarball of an exact commit and extracts it. codeload does not count against the API rate limit. */
async function downloadRepo(owner: string, repo: string, commit: string, into: string): Promise<void> {
  const tar = await which('tar');
  if (!tar) throw new SourceError('The tar command is needed to unpack downloads and was not found.');
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`, {
    headers: { 'user-agent': userAgent() },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new SourceError(`Download failed with status ${response.status}.`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new SourceError(`The repository archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  const archive = join(into, 'source.tar.gz');
  let received = 0;
  const limited = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_ARCHIVE_BYTES) limited.destroy(new SourceError('The repository archive is larger than 100 MB.'));
  });
  await pipeline(limited, createWriteStream(archive));
  const extractTo = join(into, 'src');
  await ensureDir(extractTo);
  // Both GNU tar and bsdtar refuse absolute paths and `..` members by default; links that escape are removed below.
  const result = await run(tar, ['-xzf', archive, '-C', extractTo, '--strip-components=1', '--no-same-owner'], { timeoutMs: 120_000 });
  await rm(archive, { force: true });
  if (result.code !== 0) throw new SourceError(`Could not unpack the archive: ${result.stderr.trim().slice(0, 200)}`);
}

/** Finds every folder holding a SKILL.md, up to five levels down, skipping vendored folders. */
async function findSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const out: string[] = [];
  if (await exists(join(root, 'SKILL.md'))) out.push(root);
  for (const entry of await safeReaddir(root)) {
    if (!entry.isDirectory() || VENDORED_DIRS.has(entry.name) || entry.name.startsWith('.') && entry.name !== '.claude') continue;
    out.push(...(await findSkillDirs(join(root, entry.name), depth + 1)));
  }
  return out;
}

async function describeSkill(dir: string, sourceRoot: string, hasher: TreeHasher): Promise<QuarantineSkillInternal> {
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const parsed = parseSkillFile(raw);
  const tree = await walkTree(dir);
  const contentHash = await hasher.treeHash(dir, tree);
  const [audit, treeSha] = await Promise.all([runStaticAudit(dir, tree, parsed.data, contentHash), gitTreeSha(dir)]);
  return {
    dir,
    relPath: relative(sourceRoot, dir).split('\\').join('/'),
    name: stringField(parsed.data, 'name') ?? basename(dir),
    description: descriptionOf(parsed),
    contentHash,
    audit,
    treeSha,
  };
}

export class Quarantine {
  private items = new Map<string, QuarantineRecord>();
  private hasher = new TreeHasher();

  async fetch(spec: SourceSpec): Promise<QuarantineRecord> {
    const id = newId('q_');
    const dir = join(dataPaths.quarantine(), id);
    await ensureDir(dir);
    try {
      let sourceRoot: string;
      let commit: string | undefined;
      if (spec.kind === 'github') {
        commit = await resolveCommit(spec.owner, spec.repo, spec.ref);
        await downloadRepo(spec.owner, spec.repo, commit, dir);
        sourceRoot = join(dir, 'src');
      } else {
        if (!(await isDirectory(spec.path))) throw new SourceError(`${spec.path} is not a folder.`);
        sourceRoot = join(dir, 'src');
        await copyDir(spec.path, sourceRoot);
      }
      await stripEscapingSymlinks(sourceRoot);

      let searchRoot = sourceRoot;
      if (spec.kind === 'github' && spec.subpath) {
        searchRoot = resolve(sourceRoot, spec.subpath);
        if (!isInside(sourceRoot, searchRoot) || !(await isDirectory(searchRoot))) throw new SourceError(`${spec.subpath} does not exist in ${spec.owner}/${spec.repo}.`);
      }
      let dirs = await findSkillDirs(searchRoot);
      if (spec.kind === 'github' && spec.skill) {
        const wanted = spec.skill.toLowerCase();
        const matching = [];
        for (const d of dirs) {
          if (basename(d).toLowerCase() === wanted) matching.push(d);
          else {
            const name = stringField(parseSkillFile(await readFile(join(d, 'SKILL.md'), 'utf8')).data, 'name');
            if (name?.toLowerCase() === wanted) matching.push(d);
          }
        }
        dirs = matching;
      }
      if (!dirs.length) throw new SourceError(spec.kind === 'github' && spec.skill ? `No skill named "${spec.skill}" was found in ${spec.owner}/${spec.repo}.` : 'No SKILL.md was found in this source.');
      if (dirs.length > 200) dirs = dirs.slice(0, 200);

      const skills: QuarantineSkillInternal[] = [];
      for (const d of dirs) skills.push(await describeSkill(d, sourceRoot, this.hasher));
      const record: QuarantineRecord = { id, createdAt: new Date().toISOString(), source: spec, commit, dir, skills };
      this.items.set(id, record);
      await writeFileAtomic(join(dir, 'item.json'), JSON.stringify(record));
      return record;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string): Promise<QuarantineRecord | null> {
    if (!/^q_[\w]+$/.test(id)) return null;
    const cached = this.items.get(id);
    if (cached) return cached;
    try {
      const record = JSON.parse(await readFile(join(dataPaths.quarantine(), id, 'item.json'), 'utf8')) as QuarantineRecord;
      this.items.set(id, record);
      return record;
    } catch {
      return null;
    }
  }

  async discard(id: string): Promise<void> {
    if (!/^q_[\w]+$/.test(id)) return;
    this.items.delete(id);
    await rm(join(dataPaths.quarantine(), id), { recursive: true, force: true });
  }

  /** Deletes quarantined downloads older than a day. */
  async sweep(): Promise<void> {
    const root = dataPaths.quarantine();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (name) => {
        const info = await stat(join(root, name)).catch(() => null);
        if (info && Date.now() - info.mtimeMs > QUARANTINE_TTL_MS) await this.discard(name);
      }),
    );
  }
}

export function toPublicItem(record: QuarantineRecord): QuarantineItem {
  return {
    id: record.id,
    createdAt: record.createdAt,
    source: record.source,
    commit: record.commit,
    skills: record.skills.map(({ dir: _dir, treeSha: _treeSha, ...rest }) => rest),
  };
}
