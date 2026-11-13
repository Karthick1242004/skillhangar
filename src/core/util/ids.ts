import { createHash, randomBytes } from 'node:crypto';

export function shortHash(input: string, length = 12): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length);
}

/** Sortable unique id: base36 time plus random suffix. */
export function newId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

/** Folder-safe name: keeps letters, digits, dot, dash and underscore. */
export function safeSegment(input: string): string {
  const cleaned = input.normalize('NFKC').replace(/[^\w.-]+/g, '-').replace(/^[.-]+|-+$/g, '');
  return cleaned.slice(0, 80) || 'item';
}

/** Matches the way Claude Code compares skill names: ignores case, spacing and invisible characters. */
export function normalizeSkillName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\s]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase();
}
