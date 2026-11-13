import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { safeReaddir } from './util/fs';
import { mapLimit } from './util/limit';
import type { SkillFiles } from '../shared/types';

/** Folders holding third-party code that is counted, not read: walking 9,000 vendored files per scan is the main cost. */
export const VENDORED_DIRS = new Set(['node_modules', '.venv', 'venv', 'site-packages', '__pycache__', '.git', '.tox', '.mypy_cache', '.pytest_cache', 'ms-playwright']);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.tiff', '.avif', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.wasm', '.pyc', '.pyo', '.class', '.jar', '.o', '.a', '.node',
  '.ogg', '.mp3', '.wav', '.flac', '.m4a', '.mp4', '.mov', '.webm', '.mkv', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.dat', '.pak', '.db', '.sqlite', '.parquet', '.npy', '.pt', '.onnx', '.glb', '.psd', '.ai', '.sketch', '.fig',
]);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.rb', '.pl', '.ps1', '.psm1', '.bat', '.cmd', '.php', '.lua', '.go', '.rs', '.swift', '.applescript', '.scpt']);
const NATIVE_EXT = new Set(['.so', '.dylib', '.dll', '.exe', '.bin', '.node', '.wasm']);

export interface TreeFile {
  rel: string;
  size: number;
  mtimeMs: number;
  kind: 'text' | 'binary' | 'symlink';
  script: boolean;
  native: boolean;
  linkTarget?: string;
}

export interface TreeWalk {
  files: TreeFile[];
  vendoredDirs: string[];
  /** Relative paths of files under vendored folders, in walk order. Not stat-ed. */
  vendoredFiles: string[];
}

export function classifyExtension(name: string): { binary: boolean; script: boolean; native: boolean } {
  const ext = extname(name).toLowerCase();
  return { binary: BINARY_EXT.has(ext), script: SCRIPT_EXT.has(ext), native: NATIVE_EXT.has(ext) };
}

/** Walks a skill folder. Symlinks are recorded, never followed, so a link cannot pull outside files into a scan. */
export async function walkTree(root: string, options: { maxFiles?: number } = {}): Promise<TreeWalk> {
  const maxFiles = options.maxFiles ?? 50_000;
  const files: TreeFile[] = [];
  const vendoredDirs: string[] = [];
  const vendoredFiles: string[] = [];

  async function countVendored(dir: string, rel: string): Promise<void> {
    for (const entry of await safeReaddir(dir)) {
      if (vendoredFiles.length >= maxFiles) return;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await countVendored(join(dir, entry.name), childRel);
      else vendoredFiles.push(childRel);
    }
  }

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await safeReaddir(dir);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: [string, string][] = [];
    await mapLimit(entries, 32, async (entry) => {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (VENDORED_DIRS.has(entry.name)) {
          vendoredDirs.push(childRel);
          if (entry.name !== '.git') await countVendored(full, childRel);
        } else {
          subdirs.push([full, childRel]);
        }
        return;
      }
      const info = await lstat(full).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink()) {
        files.push({ rel: childRel, size: 0, mtimeMs: info.mtimeMs, kind: 'symlink', script: false, native: false, linkTarget: await readlink(full).catch(() => '') });
        return;
      }
      if (!info.isFile()) return;
      const cls = classifyExtension(entry.name);
      files.push({ rel: childRel, size: info.size, mtimeMs: info.mtimeMs, kind: cls.binary ? 'binary' : 'text', script: cls.script, native: cls.native });
    });
    for (const [full, childRel] of subdirs.sort((a, b) => (a[1] < b[1] ? -1 : 1))) await walk(full, childRel);
  }

  await walk(root, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  vendoredDirs.sort();
  return { files, vendoredDirs, vendoredFiles };
}

export function summarizeFiles(tree: TreeWalk): SkillFiles {
  let bytes = 0;
  let scripts = 0;
  let binaries = 0;
  for (const f of tree.files) {
    bytes += f.size;
    if (f.script) scripts++;
    if (f.native) binaries++;
  }
  return {
    count: tree.files.length + tree.vendoredFiles.length,
    bytes,
    scripts,
    binaries,
    vendored: { dirs: tree.vendoredDirs, files: tree.vendoredFiles.length },
  };
}

interface CachedHash {
  size: number;
  mtimeMs: number;
  hash: string;
}

/**
 * Content hashing with a stat-keyed cache: a file is re-read only when its size or mtime changes.
 * The cache is plain data so the store can persist it between runs.
 */
export class TreeHasher {
  constructor(private cache: Map<string, CachedHash> = new Map()) {}

  get entries(): Map<string, CachedHash> {
    return this.cache;
  }

  async fileHash(absPath: string, size: number, mtimeMs: number): Promise<string> {
    const cached = this.cache.get(absPath);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.hash;
    const hash = await hashFile(absPath);
    this.cache.set(absPath, { size, mtimeMs, hash });
    return hash;
  }

  /**
   * SHA-256 over sorted (path, content hash) pairs. Vendored files contribute their paths only, so adding
   * or removing a dependency changes the hash but an in-place edit inside node_modules does not.
   */
  async treeHash(root: string, tree: TreeWalk): Promise<string> {
    const lines = await mapLimit(tree.files, 16, async (f) => {
      if (f.kind === 'symlink') return `L ${f.rel}\0${f.linkTarget ?? ''}`;
      return `F ${f.rel}\0${await this.fileHash(join(root, f.rel), f.size, f.mtimeMs)}`;
    });
    const hash = createHash('sha256');
    for (const line of lines) hash.update(line).update('\n');
    for (const rel of tree.vendoredFiles) hash.update(`V ${rel}\n`);
    return hash.digest('hex');
  }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
