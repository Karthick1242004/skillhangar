import { createHash } from 'node:crypto';
import { readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeReaddir } from '../util/fs';

/**
 * Computes the git tree SHA-1 of a folder the way `git write-tree` would, without git. Upstream
 * GitHub reports the same value for the folder, so comparing the two answers "is there an update?"
 * with no download. Ignores `.git`, like git itself.
 */
export async function gitTreeSha(dir: string): Promise<string> {
  const entries = (await safeReaddir(dir)).filter((e) => e.name !== '.git');
  const items: { name: string; mode: string; sha: Buffer; sortKey: string }[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sha = await gitTreeSha(full);
      // Git skips empty trees.
      if (sha === EMPTY_TREE) continue;
      items.push({ name: entry.name, mode: '40000', sha: Buffer.from(sha, 'hex'), sortKey: `${entry.name}/` });
    } else if (entry.isSymbolicLink()) {
      items.push({ name: entry.name, mode: '120000', sha: blobSha(Buffer.from(await readlink(full))), sortKey: entry.name });
    } else if (entry.isFile()) {
      const { mode } = await stat(full);
      items.push({ name: entry.name, mode: mode & 0o111 ? '100755' : '100644', sha: blobSha(await readFile(full)), sortKey: entry.name });
    }
  }
  items.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const body = Buffer.concat(items.flatMap((i) => [Buffer.from(`${i.mode} ${i.name}\0`), i.sha]));
  return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function blobSha(content: Buffer): Buffer {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest();
}
