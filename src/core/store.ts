import { appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPaths } from './paths';
import { ensureDir, readJsonResilient, writeFileAtomic } from './util/fs';
import { KeyedMutex } from './util/limit';
import type { ActivityEntry, Provenance, Settings } from '../shared/types';

const mutex = new KeyedMutex();

/**
 * One JSON document on disk with an in-memory copy. Updates are serialized and written atomically,
 * so concurrent requests never lose each other's changes.
 */
export class JsonDoc<T> {
  private value: T | null = null;

  constructor(
    private readonly pathOf: () => string,
    private readonly defaults: () => T,
  ) {}

  private get path(): string {
    return this.pathOf();
  }

  /** Drops the in-memory copy (tests, or after an external edit). */
  reset(): void {
    this.value = null;
  }

  async get(): Promise<T> {
    if (this.value) return this.value;
    const loaded = await readJsonResilient<Partial<T>>(this.path).catch(() => null);
    this.value = { ...this.defaults(), ...(loaded ?? {}) } as T;
    return this.value;
  }

  update(mutate: (draft: T) => void): Promise<T> {
    return mutex.run(this.path, async () => {
      const current = structuredClone(await this.get());
      mutate(current);
      await writeFileAtomic(this.path, JSON.stringify(current, null, 2), 0o600);
      this.value = current;
      return current;
    });
  }
}

export interface InstallRecord {
  name: string;
  path: string;
  provenance: Provenance;
  installedAt: string;
  updatedAt: string;
  contentHash: string;
  mode: 'copy' | 'symlink';
}

export interface ReviewRecord {
  reviewedAt: string;
  contentHash: string;
}

export interface Registry {
  version: 1;
  /** Keyed by the real path of the installed skill folder. */
  installs: Record<string, InstallRecord>;
  /** Keyed by real path. */
  reviews: Record<string, ReviewRecord>;
  /** Keyed by real path: when Skillhangar first saw a skill with no other install date. */
  firstSeen: Record<string, string>;
  /** Keyed by real path: newest Claude audit id per skill. */
  latestClaudeAudit: Record<string, { file: string; contentHash: string; verdict: string; model: string; at: string }>;
  /** Keyed by real path, then scanner id. */
  latestScanner: Record<string, Record<string, { contentHash: string; verdict: string; at: string }>>;
}

export const registry = new JsonDoc<Registry>(dataPaths.registry, () => ({
  version: 1,
  installs: {},
  reviews: {},
  firstSeen: {},
  latestClaudeAudit: {},
  latestScanner: {},
}));

export const DEFAULT_SETTINGS: Settings = {
  network: { enabled: false, decidedAt: null },
  audit: { defaultModel: 'sonnet', budgetUsd: 0.5, maxTurns: 24 },
  projects: [],
  theme: 'system',
};

export const settings = new JsonDoc<Settings>(dataPaths.settings, () => structuredClone(DEFAULT_SETTINGS));

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await mutex.run(path, () => appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
}

/** Reads a JSONL file, skipping lines that fail to parse (a crash can leave a partial last line). */
export async function readJsonl<T>(path: string, limit = Infinity): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn line
    }
  }
  return out.reverse();
}

export async function recordActivity(entry: ActivityEntry): Promise<void> {
  await appendJsonl(dataPaths.activity(), entry);
}

export async function readActivity(limit = 200): Promise<ActivityEntry[]> {
  const entries = await readJsonl<ActivityEntry>(dataPaths.activity(), 2000);
  // Later "undone" markers apply to earlier entries.
  const undone = new Set(entries.filter((e) => e.action === 'undo').map((e) => e.target));
  return entries
    .filter((e) => e.action !== 'undo')
    .map((e) => (undone.has(e.id) ? { ...e, undone: true } : e))
    .slice(-limit)
    .reverse();
}
