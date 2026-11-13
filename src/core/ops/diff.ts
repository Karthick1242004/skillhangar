import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { TreeHasher, walkTree } from '../tree';
import type { DiffFile } from '../../shared/types';

const MAX_FILE_FOR_PATCH = 256 * 1024;
const MAX_TOTAL_PATCH = 1024 * 1024;

/** File-level diff of two skill folders with unified patches for changed text files, size-capped. */
export async function diffDirs(oldDir: string, newDir: string, hasher: TreeHasher): Promise<DiffFile[]> {
  const [oldTree, newTree] = await Promise.all([walkTree(oldDir), walkTree(newDir)]);
  const oldFiles = new Map(oldTree.files.map((f) => [f.rel, f]));
  const newFiles = new Map(newTree.files.map((f) => [f.rel, f]));
  const out: DiffFile[] = [];
  let budget = MAX_TOTAL_PATCH;

  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
  for (const rel of paths) {
    const before = oldFiles.get(rel);
    const after = newFiles.get(rel);
    const binary = (before ?? after)!.kind === 'binary';
    if (before && after) {
      if (before.kind === 'symlink' || after.kind === 'symlink') {
        if (before.linkTarget !== after.linkTarget) out.push({ path: rel, status: 'modified', binary: false, patch: `link ${before.linkTarget ?? '(file)'} → ${after.linkTarget ?? '(file)'}` });
        continue;
      }
      const [a, b] = await Promise.all([hasher.fileHash(join(oldDir, rel), before.size, before.mtimeMs), hasher.fileHash(join(newDir, rel), after.size, after.mtimeMs)]);
      if (a === b) continue;
      out.push(await withPatch({ path: rel, status: 'modified', binary }, before.size, after.size, join(oldDir, rel), join(newDir, rel)));
    } else if (after) {
      out.push(await withPatch({ path: rel, status: 'added', binary }, 0, after.size, null, join(newDir, rel)));
    } else {
      out.push(await withPatch({ path: rel, status: 'removed', binary }, before!.size, 0, join(oldDir, rel), null));
    }
  }
  return out;

  async function withPatch(file: DiffFile, oldSize: number, newSize: number, oldPath: string | null, newPath: string | null): Promise<DiffFile> {
    if (file.binary || oldSize > MAX_FILE_FOR_PATCH || newSize > MAX_FILE_FOR_PATCH || budget <= 0) return { ...file, truncated: !file.binary };
    const [a, b] = await Promise.all([oldPath ? readFile(oldPath, 'utf8') : '', newPath ? readFile(newPath, 'utf8') : '']);
    let patch = createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, a, b, undefined, undefined, { context: 3 });
    const truncated = patch.length > budget;
    if (truncated) patch = patch.slice(0, budget);
    budget -= patch.length;
    return { ...file, patch, truncated };
  }
}
