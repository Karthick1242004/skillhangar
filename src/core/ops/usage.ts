import { createReadStream } from 'node:fs';
import { copyFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { editSettingsFile } from './settings-file';
import { dataPaths } from '../paths';
import { readJsonl } from '../store';
import { ensureDir, readJsonResilient } from '../util/fs';
import { mapLimit } from '../util/limit';
import type { Profile, SkillUsage, UsageReport } from '../../shared/types';

const HOOK_MARKER = '.skillhangar/hook.mjs';

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}
type HooksJson = { hooks?: Record<string, HookGroup[]> };

function hookCommand(): string {
  return `node "${dataPaths.hookScript()}"`;
}

/** The compiled hook sits next to this bundle; it is copied to a stable path so an npx cache purge cannot break it. */
async function installHookScript(): Promise<void> {
  await ensureDir(dataPaths.hookScript().replace(/[/\\][^/\\]+$/, ''));
  const source = fileURLToPath(new URL('./hook.js', import.meta.url));
  await copyFile(source, dataPaths.hookScript());
}

function isOurs(command: string | undefined): boolean {
  return !!command && command.replaceAll('\\', '/').includes(HOOK_MARKER);
}

export async function isHookInstalled(profile: Profile): Promise<boolean> {
  const json = await readJsonResilient<HooksJson>(join(profile.configDir, 'settings.json')).catch(() => null);
  return Object.values(json?.hooks ?? {}).some((groups) => groups.some((g) => g.hooks?.some((h) => isOurs(h.command))));
}

/**
 * Adds two hooks to the profile's settings: PreToolUse on the Skill tool (Claude invoking a skill) and
 * UserPromptSubmit (a person typing /name). Both run a tiny script that appends one JSON line and exits 0.
 */
export async function setUsageHook(profile: Profile, enabled: boolean): Promise<void> {
  if (enabled) await installHookScript();
  await editSettingsFile<HooksJson>(join(profile.configDir, 'settings.json'), (json) => {
    const hooks = json.hooks ?? {};
    for (const event of Object.keys(hooks)) {
      hooks[event] = (hooks[event] ?? [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command)) }))
        .filter((g) => g.hooks.length > 0);
      if (!hooks[event]!.length) delete hooks[event];
    }
    if (enabled) {
      const entry = { type: 'command', command: hookCommand() };
      hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { matcher: 'Skill', hooks: [entry] }];
      hooks.UserPromptSubmit = [...(hooks.UserPromptSubmit ?? []), { hooks: [entry] }];
    }
    if (Object.keys(hooks).length) json.hooks = hooks;
    else delete json.hooks;
  });
}

interface UsageLine {
  ts: string;
  skill: string;
  via: 'tool' | 'slash';
}

let transcriptCache: { at: number; data: Map<string, SkillUsage> } | null = null;

/**
 * Estimates usage from session transcripts: Skill tool calls and typed slash commands. The transcript
 * format is internal to Claude Code and may change, so this is labelled an estimate and only reads
 * the last 90 days.
 */
async function scanTranscripts(profiles: Profile[]): Promise<Map<string, SkillUsage>> {
  if (transcriptCache && Date.now() - transcriptCache.at < 10 * 60 * 1000) return transcriptCache.data;
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const files: string[] = [];
  for (const profile of profiles) {
    const root = join(profile.configDir, 'projects');
    for (const project of await readdir(root).catch(() => [] as string[])) {
      for (const name of await readdir(join(root, project)).catch(() => [] as string[])) {
        if (!name.endsWith('.jsonl')) continue;
        const full = join(root, project, name);
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs >= cutoff) files.push(full);
      }
    }
  }
  const usage = new Map<string, SkillUsage>();
  const add = (name: string, ts: string | undefined) => {
    const key = name.toLowerCase();
    const entry = usage.get(key) ?? { name, count: 0, lastUsed: null, source: 'transcripts' as const };
    entry.count++;
    if (ts && (!entry.lastUsed || ts > entry.lastUsed)) entry.lastUsed = ts;
    usage.set(key, entry);
  };
  await mapLimit(files, 4, async (file) => {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const hasTool = line.includes('"name":"Skill"');
      const hasSlash = line.includes('<command-name>/');
      if (!hasTool && !hasSlash) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string; message?: { content?: unknown } };
        const content = entry.message?.content;
        if (hasTool && Array.isArray(content)) {
          for (const item of content as { type?: string; name?: string; input?: { skill?: string } }[]) {
            if (item.type === 'tool_use' && item.name === 'Skill' && item.input?.skill) add(item.input.skill, entry.timestamp);
          }
        }
        if (hasSlash) {
          const text = typeof content === 'string' ? content : JSON.stringify(content);
          const m = /<command-name>\/([\w:.-]+)<\/command-name>/.exec(text);
          if (m) add(m[1]!, entry.timestamp);
        }
      } catch {
        // a line that is not JSON
      }
    }
  });
  transcriptCache = { at: Date.now(), data: usage };
  return usage;
}

export async function usageReport(profiles: Profile[], includeTranscripts: boolean): Promise<UsageReport> {
  const hookInstalled = Object.fromEntries(await Promise.all(profiles.map(async (p) => [p.id, await isHookInstalled(p)] as const)));
  const lines = await readJsonl<UsageLine>(dataPaths.usage());
  const byName = new Map<string, SkillUsage>();
  for (const line of lines) {
    const key = line.skill.toLowerCase();
    const entry = byName.get(key) ?? { name: line.skill, count: 0, lastUsed: null, source: 'hook' as const };
    entry.count++;
    if (!entry.lastUsed || line.ts > entry.lastUsed) entry.lastUsed = line.ts;
    byName.set(key, entry);
  }
  let estimated = false;
  if (includeTranscripts) {
    estimated = true;
    for (const [key, value] of await scanTranscripts(profiles)) if (!byName.has(key)) byName.set(key, value);
  }
  return {
    hookInstalled,
    since: lines[0]?.ts ?? null,
    skills: [...byName.values()].sort((a, b) => b.count - a.count),
    estimatedFromTranscripts: estimated,
  };
}
