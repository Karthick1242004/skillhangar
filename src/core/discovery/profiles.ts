import { basename, join, resolve } from 'node:path';
import { home } from '../paths';
import { exists, isDirectory, realpathOrNull, safeReaddir } from '../util/fs';
import type { Profile } from '../../shared/types';

/**
 * Finds every Claude Code configuration folder on this machine: the default `~/.claude`, the one
 * `CLAUDE_CONFIG_DIR` points at, and any `~/.claude-*` folder that holds a settings or config file.
 * The default profile keeps its config file at `~/.claude.json`; relocated profiles keep it inside
 * the folder (verified on a machine with both layouts).
 */
export async function detectProfiles(): Promise<Profile[]> {
  const h = home();
  const activeDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(h, '.claude');
  const candidates = new Set<string>([join(h, '.claude')]);
  if (process.env.CLAUDE_CONFIG_DIR) candidates.add(resolve(process.env.CLAUDE_CONFIG_DIR));
  for (const entry of await safeReaddir(h)) {
    if (entry.isDirectory() && /^\.claude-[\w.-]+$/.test(entry.name)) candidates.add(join(h, entry.name));
  }

  const profiles: Profile[] = [];
  for (const dir of candidates) {
    if (!(await isDirectory(dir))) continue;
    const isDefault = dir === join(h, '.claude');
    const configFile = isDefault ? join(h, '.claude.json') : join(dir, '.claude.json');
    if (!isDefault && dir !== activeDir && !(await looksLikeProfile(dir))) continue;
    const skillsDir = join(dir, 'skills');
    profiles.push({
      id: isDefault ? 'default' : basename(dir).replace(/^\./, ''),
      label: isDefault ? '~/.claude' : `~/${basename(dir)}`,
      configDir: dir,
      configFile,
      isDefault,
      isActive: resolve(dir) === activeDir,
      skillsDir,
      skillsRealDir: await realpathOrNull(skillsDir),
    });
  }
  return profiles.sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

/**
 * Tools such as claude-mem keep a private config folder next to the real ones (`~/.claude-mem` holds a
 * `settings.json` and `.claude.json`). A folder counts as a profile only when a person has used it:
 * it holds sessions, projects, skills, plugins or history.
 */
async function looksLikeProfile(dir: string): Promise<boolean> {
  for (const marker of ['projects', 'skills', 'plugins', 'history.jsonl', 'sessions']) {
    if (await exists(join(dir, marker))) return true;
  }
  return false;
}

/** Environment for a `claude` child process that must act on a specific profile. */
export function profileEnv(profile: Profile): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (profile.isDefault) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = profile.configDir;
  return env;
}
