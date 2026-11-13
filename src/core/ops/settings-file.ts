import { copyFile, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dataPaths } from '../paths';
import { ensureDir, realpathOrNull, writeFileAtomic } from '../util/fs';
import { KeyedMutex } from '../util/limit';

const mutex = new KeyedMutex();

export class SettingsConflictError extends Error {}

/**
 * Edits a Claude Code settings JSON file safely:
 * - refuses to touch a file that does not parse (it never overwrites what it cannot read);
 * - backs the original up under ~/.skillhangar/backups first;
 * - re-checks the modification time before writing and retries once if Claude Code wrote in between;
 * - writes atomically, keeping two-space indentation and the file's permissions;
 * - follows a symlinked settings file (dotfile managers) and writes the target, never replacing the link.
 */
export function editSettingsFile<T extends Record<string, unknown>>(settingsPath: string, mutate: (json: T) => void): Promise<{ before: T; after: T }> {
  return mutex.run(settingsPath, async () => {
    const path = (await realpathOrNull(settingsPath)) ?? settingsPath;
    for (let attempt = 0; attempt < 2; attempt++) {
      const info = await stat(path).catch(() => null);
      let raw = '';
      if (info) raw = await readFile(path, 'utf8');
      let before: T;
      try {
        before = (raw.trim() ? JSON.parse(raw) : {}) as T;
      } catch (error) {
        throw new Error(`${path} is not valid JSON (${(error as Error).message}). Fix it by hand; Skillhangar will not overwrite a file it cannot read.`);
      }
      if (typeof before !== 'object' || before === null || Array.isArray(before)) throw new Error(`${path} does not hold a JSON object.`);
      const after = structuredClone(before);
      mutate(after);
      const now = await stat(path).catch(() => null);
      if ((now?.mtimeMs ?? 0) !== (info?.mtimeMs ?? 0)) continue;
      if (info) {
        await ensureDir(dataPaths.backups());
        await copyFile(path, join(dataPaths.backups(), `${basename(path)}.${Date.now()}.bak`));
      }
      await writeFileAtomic(path, `${JSON.stringify(after, null, 2)}\n`, info ? info.mode & 0o777 : 0o600);
      return { before, after };
    }
    throw new SettingsConflictError(`${path} kept changing while Skillhangar tried to edit it. Try again in a moment.`);
  });
}
