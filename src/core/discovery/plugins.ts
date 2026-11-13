import { join } from 'node:path';
import { profileEnv } from './profiles';
import { isDirectory, readJsonResilient, safeReaddir } from '../util/fs';
import { run, which } from '../util/proc';
import type { PluginRecord, Profile } from '../../shared/types';

interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  projectPath?: string;
}

export interface CliPlugin {
  id: string;
  enabled?: boolean;
  scope?: string;
  projectPath?: string;
}

/**
 * Plugins come from `plugins/installed_plugins.json` (fast, and the only place with `gitCommitSha`).
 * Enabled state here comes from `enabledPlugins` in the user or project settings; the authoritative
 * `claude plugin list --json` (about 650 ms per profile) runs off the critical path and is merged in
 * afterwards with `applyPluginStates`.
 */
export async function discoverPlugins(profile: Profile): Promise<PluginRecord[]> {
  const pluginsDir = join(profile.configDir, 'plugins');
  const [installed, marketplaces, settingsJson] = await Promise.all([
    readJsonResilient<{ version?: number; plugins?: Record<string, InstalledPluginEntry[] | InstalledPluginEntry> }>(join(pluginsDir, 'installed_plugins.json')).catch(() => null),
    readJsonResilient<Record<string, { source?: { source?: string; repo?: string; url?: string } }>>(join(pluginsDir, 'known_marketplaces.json')).catch(() => null),
    readJsonResilient<{ enabledPlugins?: Record<string, boolean> }>(join(profile.configDir, 'settings.json')).catch(() => null),
  ]);
  if (!installed?.plugins) return [];

  const records: PluginRecord[] = [];
  for (const [id, raw] of Object.entries(installed.plugins)) {
    const entries = Array.isArray(raw) ? raw : [raw];
    const [name = id, marketplace = ''] = id.split('@');
    const market = marketplaces?.[marketplace]?.source;
    for (const entry of entries) {
      if (!entry.installPath) continue;
      const projectSettings = entry.projectPath
        ? await readJsonResilient<{ enabledPlugins?: Record<string, boolean> }>(join(entry.projectPath, '.claude', 'settings.json')).catch(() => null)
        : null;
      const enabled = (entry.projectPath ? projectSettings?.enabledPlugins?.[id] : settingsJson?.enabledPlugins?.[id]) ?? null;
      records.push({
        id,
        name,
        marketplace,
        version: entry.version ?? 'unknown',
        scope: entry.scope ?? 'user',
        enabled,
        installPath: entry.installPath,
        installedAt: entry.installedAt,
        lastUpdated: entry.lastUpdated,
        gitCommitSha: entry.gitCommitSha,
        projectPath: entry.projectPath,
        profileIds: [profile.id],
        skillCount: await countPluginSkills(entry.installPath),
        marketplaceRepo: market?.repo ?? market?.url,
      });
    }
  }
  return records;
}

async function countPluginSkills(installPath: string): Promise<number> {
  const dir = join(installPath, 'skills');
  if (!(await isDirectory(dir))) return 0;
  return (await safeReaddir(dir)).filter((e) => e.isDirectory() || e.isSymbolicLink()).length;
}

/** Overwrites enabled state with what the CLI reports. Plugins the CLI does not list keep their value. */
export function applyPluginStates(plugins: PluginRecord[], states: Map<string, CliPlugin[] | null>): boolean {
  let changed = false;
  for (const plugin of plugins) {
    for (const profileId of plugin.profileIds) {
      const match = states.get(profileId)?.find((p) => p.id === plugin.id && (p.projectPath ?? '') === (plugin.projectPath ?? ''));
      if (match && typeof match.enabled === 'boolean' && match.enabled !== plugin.enabled) {
        plugin.enabled = match.enabled;
        changed = true;
      }
    }
  }
  return changed;
}

export async function fetchPluginStates(profile: Profile): Promise<CliPlugin[] | null> {
  const claude = await which('claude');
  if (!claude) return null;
  try {
    const result = await run(claude, ['plugin', 'list', '--json'], { env: profileEnv(profile), timeoutMs: 8000 });
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CliPlugin[]) : null;
  } catch {
    return null;
  }
}
