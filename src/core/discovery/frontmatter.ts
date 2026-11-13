import { parse } from 'yaml';
import type { SkillMeta } from '../../shared/types';

export interface ParsedSkillFile {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line where the body starts, so findings in the body report real line numbers. */
  bodyStartLine: number;
  error: string | null;
  hasFrontmatter: boolean;
}

const KNOWN_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable',
  'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell',
  'metadata', 'license', 'compatibility', 'version',
]);

export function parseSkillFile(raw: string): ParsedSkillFile {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text, bodyStartLine: 1, error: null, hasFrontmatter: false };
  const yamlText = match[1] ?? '';
  const bodyStartLine = yamlText.split('\n').length + 3;
  const body = text.slice(match[0].length);
  try {
    // Untrusted input: cap alias expansion so a "billion laughs" document cannot exhaust memory.
    const data = parse(yamlText, { maxAliasCount: 100, uniqueKeys: false, prettyErrors: false });
    if (data === null || data === undefined) return { data: {}, body, bodyStartLine, error: null, hasFrontmatter: true };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, body, bodyStartLine, error: 'Frontmatter is not a key-value map', hasFrontmatter: true };
    }
    return { data: data as Record<string, unknown>, body, bodyStartLine, error: null, hasFrontmatter: true };
  } catch (error) {
    // Many published skills put an unquoted ": " inside the description, which strict YAML rejects but
    // Claude Code tolerates. Fall back to reading top-level `key: value` lines so nothing is lost.
    return { data: lenientFrontmatter(yamlText), body, bodyStartLine, error: (error as Error).message.split('\n')[0] ?? 'Invalid YAML', hasFrontmatter: true };
  }
}

function lenientFrontmatter(yamlText: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of yamlText.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2]!.trim();
    data[m[1]!] = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return data;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Tool lists accept a YAML list or a space- or comma-separated string; parentheses keep their spaces. */
export function parseToolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => asString(v)?.trim()).filter((v): v is string => !!v);
  const text = asString(value);
  if (!text) return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function toSkillMeta(data: Record<string, unknown>): SkillMeta {
  const metadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;
  return {
    allowedTools: parseToolList(data['allowed-tools']),
    disallowedTools: parseToolList(data['disallowed-tools']),
    disableModelInvocation: asBool(data['disable-model-invocation'], false),
    userInvocable: asBool(data['user-invocable'], true),
    model: asString(data.model),
    effort: asString(data.effort),
    context: asString(data.context),
    agent: asString(data.agent),
    paths: parseToolList(data.paths),
    shell: asString(data.shell),
    hasHooks: data.hooks !== undefined && data.hooks !== null,
    argumentHint: asString(data['argument-hint']),
    license: asString(data.license),
    version: asString(data.version) ?? asString(metadata.version),
    unknownKeys: Object.keys(data).filter((k) => !KNOWN_KEYS.has(k)),
  };
}

/** Claude Code falls back to the first non-empty body line when `description` is missing. */
export function descriptionOf(parsed: ParsedSkillFile): string {
  const fromFrontmatter = asString(parsed.data.description)?.trim();
  if (fromFrontmatter) return fromFrontmatter;
  const firstLine = parsed.body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
  return firstLine?.trim() ?? '';
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  return asString(data[key])?.trim() || undefined;
}
