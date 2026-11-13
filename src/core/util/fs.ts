import { constants, type Dirent } from 'node:fs';
import { access, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function readTextCapped(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { text: buffer.toString('utf8'), truncated: size > maxBytes };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Reads JSON that another process may be rewriting (Claude Code rewrites `.claude.json` often).
 * A parse failure is retried a few times before giving up, so a half-written file is not
 * mistaken for an empty config.
 */
export async function readJsonResilient<T = unknown>(path: string, attempts = 4): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
  throw new Error(`Could not parse JSON after ${attempts} attempts: ${path}`);
}

/** Writes through a temp file in the same directory and renames, so readers never see a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Moves a directory, falling back to copy-and-delete when source and target are on different devices. */
export async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/** Copies a directory tree, keeping symlinks as links (never following them out of the tree). */
export async function copyDir(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
}

/** True when `child` is `parent` or inside it, after resolving both. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..' && !/^[a-zA-Z]:/.test(rel));
}

export async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Removes every symlink under `root` whose target resolves outside `root`, and returns their paths.
 * Used after extracting an untrusted archive.
 */
export async function stripEscapingSymlinks(root: string): Promise<string[]> {
  const removed: string[] = [];
  const rootReal = await realpath(root);
  async function walk(dir: string): Promise<void> {
    for (const entry of await safeReaddir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(full), await readlink(full));
        const targetReal = (await realpathOrNull(target)) ?? target;
        if (!isInside(rootReal, targetReal)) {
          await rm(full, { force: true });
          removed.push(relative(root, full));
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
  return removed;
}

export async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export { copyFile, symlink, rm, readFile, stat, mkdir };
