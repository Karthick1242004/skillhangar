import type { SkillScope, Verdict } from '@shared/types';

const numberFormat = new Intl.NumberFormat('en');
const compactFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' });

export const n = (value: number) => numberFormat.format(value);
export const compact = (value: number) => compactFormat.format(value);

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFormat.format(d);
}

export function time(iso: string | null | undefined): string {
  if (!iso) return '—';
  return timeFormat.format(new Date(iso));
}

/** "Today", "Yesterday", "6 days ago", then a date. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return dateFormat.format(then);
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export const SCOPE_LABEL: Record<SkillScope, string> = {
  managed: 'Managed',
  personal: 'Personal',
  project: 'Project',
  plugin: 'Plugin',
  synced: 'claude.ai',
  'legacy-command': 'Command',
  'agents-store': 'Not linked',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  safe: 'No issues',
  caution: 'Review',
  dangerous: 'Dangerous',
  unknown: 'Not audited',
};

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** Shortens a home-relative path for display: /Users/x/.claude/skills/a becomes ~/.claude/skills/a. */
export function tildify(path: string | undefined): string {
  if (!path) return '';
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}
