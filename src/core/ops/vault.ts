import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dataPaths } from '../paths';
import { copyDir, ensureDir, exists, moveDir, writeFileAtomic } from '../util/fs';
import { newId, safeSegment } from '../util/ids';
import type { SnapshotInfo, TrashItem } from '../../shared/types';

const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[\w-]+$/;

/**
 * Nothing Skillhangar removes is deleted outright. Removals move into the trash (restorable for 30 days)
 * and every update first copies the current version into a snapshot.
 */
export const vault = {
  async trash(path: string, kind: TrashItem['kind'], name = basename(path)): Promise<TrashItem> {
    const id = newId('t_');
    const dir = join(dataPaths.trash(), id);
    await ensureDir(dir);
    const item: TrashItem = { id, originalPath: path, name, kind, trashedAt: new Date().toISOString() };
    await moveDir(path, join(dir, 'payload'));
    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(item));
    return item;
  },

  async listTrash(): Promise<TrashItem[]> {
    return listMeta<TrashItem>(dataPaths.trash(), (a, b) => b.trashedAt.localeCompare(a.trashedAt));
  },

  async restoreTrash(id: string): Promise<TrashItem> {
    if (!ID.test(id)) throw new Error('Invalid trash id.');
    const dir = join(dataPaths.trash(), id);
    const item = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashItem;
    if (await lstat(item.originalPath).catch(() => null)) throw new Error(`${item.originalPath} already exists. Move it away before restoring.`);
    await moveDir(join(dir, 'payload'), item.originalPath);
    await rm(dir, { recursive: true, force: true });
    return item;
  },

  async sweepTrash(): Promise<void> {
    for (const item of await this.listTrash()) {
      if (Date.now() - Date.parse(item.trashedAt) > TRASH_TTL_MS) await rm(join(dataPaths.trash(), item.id), { recursive: true, force: true });
    }
  },

  async snapshot(skillDir: string, name: string, reason: string, contentHash: string): Promise<SnapshotInfo> {
    const id = `${newId('s_')}-${safeSegment(name)}`;
    const dir = join(dataPaths.snapshots(), id);
    await ensureDir(dir);
    await copyDir(skillDir, join(dir, 'payload'));
    const info: SnapshotInfo = { id, skillPath: skillDir, name, reason, createdAt: new Date().toISOString(), contentHash };
    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(info));
    return info;
  },

  async listSnapshots(skillPath?: string): Promise<SnapshotInfo[]> {
    const all = await listMeta<SnapshotInfo>(dataPaths.snapshots(), (a, b) => b.createdAt.localeCompare(a.createdAt));
    return skillPath ? all.filter((s) => s.skillPath === skillPath) : all;
  },

  /** Puts a snapshot back. The version it replaces goes to the trash, so a restore can be undone too. */
  async restoreSnapshot(id: string): Promise<{ snapshot: SnapshotInfo; replaced: TrashItem | null }> {
    if (!ID.test(id)) throw new Error('Invalid snapshot id.');
    const dir = join(dataPaths.snapshots(), id);
    const snapshot = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SnapshotInfo;
    const replaced = (await exists(snapshot.skillPath)) ? await this.trash(snapshot.skillPath, 'snapshot-replaced', snapshot.name) : null;
    await copyDir(join(dir, 'payload'), snapshot.skillPath);
    return { snapshot, replaced };
  },
};

async function listMeta<T>(root: string, order: (a: T, b: T) => number): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const items = await Promise.all(names.map((n) => readFile(join(root, n, 'meta.json'), 'utf8').then((t) => JSON.parse(t) as T).catch(() => null)));
  return items.filter((i): i is Awaited<T> => i !== null).sort(order) as T[];
}
