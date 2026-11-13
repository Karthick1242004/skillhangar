import { readFile } from 'node:fs/promises';
import { fetchJson } from './http';
import { dataPaths } from '../paths';
import { writeFileAtomic } from '../util/fs';
import { mapLimit } from '../util/limit';

/**
 * GitHub has no trending API and no official "repository of the day". This index is built from
 * antonkomarev/github-trending-archive (MIT): one scraped daily snapshot of the all-languages page from
 * 2021-12-31 on, at archive/repository/YYYY/YYYY-MM-DD/(null).json. It has no ranks, so the UI says
 * "on GitHub Trending N days" and "no record in the archive", never "never trended".
 */
const ARCHIVE = 'https://raw.githubusercontent.com/antonkomarev/github-trending-archive/master/archive/repository';
export const ARCHIVE_START = '2021-12-31';

export interface TrendingIndex {
  through: string | null;
  /** Lowercased owner/repo to the dates it appeared, oldest first. */
  repos: Record<string, string[]>;
}

export async function loadTrending(): Promise<TrendingIndex> {
  try {
    return JSON.parse(await readFile(dataPaths.cache('trending.json'), 'utf8')) as TrendingIndex;
  } catch {
    return { through: null, repos: {} };
  }
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Fetches every day after the last indexed one. Incremental, so later runs fetch a handful of files. */
export async function updateTrending(onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<TrendingIndex> {
  const index = await loadTrending();
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = [];
  for (let day = index.through ? addDays(index.through, 1) : ARCHIVE_START; day <= today; day = addDays(day, 1)) days.push(day);
  let done = 0;
  let lastComplete: string | null = index.through;
  const lists = await mapLimit(days, 12, async (day) => {
    if (signal?.aborted) throw new Error('Cancelled');
    const url = `${ARCHIVE}/${day.slice(0, 4)}/${day}/${encodeURIComponent('(null).json')}`;
    try {
      const result = await fetchJson<{ list?: string[] }>(url, { signal, timeoutMs: 20_000 });
      return { day, list: result.data?.list ?? null, failed: false };
    } catch {
      return { day, list: null, failed: true };
    } finally {
      onProgress(++done, days.length);
    }
  });
  for (const { day, list, failed } of lists) {
    // A failed fetch (not a missing file) stops the index there, so the day is retried next time.
    if (failed) break;
    if (list) {
      for (const repo of list) {
        const key = repo.toLowerCase();
        (index.repos[key] ??= []).push(day);
      }
    }
    // Today's file may not exist yet; stop "through" at the last day before a gap at the end.
    if (list || day < today) lastComplete = day;
  }
  for (const dates of Object.values(index.repos)) dates.sort();
  index.through = lastComplete;
  await writeFileAtomic(dataPaths.cache('trending.json'), JSON.stringify(index));
  return index;
}
