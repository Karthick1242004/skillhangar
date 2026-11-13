import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditCache } from './audit/cache';
import { worseVerdict } from './audit/verdict';
import { discoverMcp, type ClaudeConfig } from './discovery/mcp';
import { applyPluginStates, discoverPlugins, fetchPluginStates } from './discovery/plugins';
import { detectProfiles } from './discovery/profiles';
import { readVercelGlobalLock, readVercelProjectLock } from './discovery/provenance';
import { collectSources, scanSkills, type ScannedSkill } from './discovery/skills';
import { dataPaths, managedDir } from './paths';
import { registry, settings } from './store';
import { TreeHasher } from './tree';
import { exists, isDirectory, readJsonResilient, realpathOrNull, writeFileAtomic } from './util/fs';
import { normalizeSkillName } from './util/ids';
import { mapLimit } from './util/limit';
import {
  DESCRIPTION_CAP,
  type ContextBudget,
  type Inventory,
  type PluginRecord,
  type PolicyRestrictions,
  type Profile,
  type SkillOverride,
  type SkillRecord,
  type SkillScope,
  type Verdict,
} from '../shared/types';

export interface InventorySnapshot {
  inventory: Inventory;
  /** Private scan data by skill id: file trees and frontmatter for audits. */
  scanned: Map<string, ScannedSkill>;
}

/** Precedence when two skills share a name: managed beats personal beats project; synced and legacy commands lose to local skills. */
const PRECEDENCE: Partial<Record<SkillScope, number>> = { managed: 0, personal: 1, project: 2, synced: 3, 'legacy-command': 4 };

let hasher: TreeHasher | null = null;

async function loadHasher(): Promise<TreeHasher> {
  if (hasher) return hasher;
  try {
    const raw = JSON.parse(await readFile(dataPaths.cache('hashes.json'), 'utf8')) as [string, { size: number; mtimeMs: number; hash: string }][];
    hasher = new TreeHasher(new Map(raw));
  } catch {
    hasher = new TreeHasher();
  }
  return hasher;
}

async function saveHasher(h: TreeHasher, validPaths: Set<string>): Promise<void> {
  // Drop entries for files that no longer exist under any scanned skill, so the cache does not grow forever.
  const entries = [...h.entries].filter(([path]) => [...validPaths].some((root) => path.startsWith(root)));
  await writeFileAtomic(dataPaths.cache('hashes.json'), JSON.stringify(entries));
}

async function readProjects(configs: Map<string, ClaudeConfig | null>, extra: string[]): Promise<string[]> {
  const candidates = new Set<string>(extra);
  for (const config of configs.values()) for (const path of Object.keys(config?.projects ?? {})) candidates.add(path);
  if (await exists(join(process.cwd(), '.claude'))) candidates.add(process.cwd());
  const checked = await mapLimit([...candidates], 24, async (path) => ((await isDirectory(path)) ? await realpathOrNull(path) : null));
  return [...new Set(checked.filter((p): p is string => !!p))].sort();
}

function mergePlugins(lists: PluginRecord[][]): PluginRecord[] {
  const byKey = new Map<string, PluginRecord>();
  for (const plugin of lists.flat()) {
    const key = `${plugin.id}|${plugin.installPath}|${plugin.projectPath ?? ''}`;
    const existing = byKey.get(key);
    if (existing) existing.profileIds = [...new Set([...existing.profileIds, ...plugin.profileIds])];
    else byKey.set(key, { ...plugin });
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type OverrideMap = Record<string, SkillOverride>;

async function readOverrides(path: string): Promise<OverrideMap> {
  const json = await readJsonResilient<{ skillOverrides?: Record<string, unknown> }>(path).catch(() => null);
  const out: OverrideMap = {};
  for (const [name, value] of Object.entries(json?.skillOverrides ?? {})) {
    if (value === 'on' || value === 'name-only' || value === 'user-invocable-only' || value === 'off') out[name] = value;
  }
  return out;
}

async function readPolicy(profiles: Profile[]): Promise<PolicyRestrictions[]> {
  const files = [
    { source: 'Managed settings', path: join(managedDir(), 'managed-settings.json') },
    ...profiles.map((p) => ({ source: `Remote settings (${p.label})`, path: join(p.configDir, 'remote-settings.json') })),
  ];
  const out: PolicyRestrictions[] = [];
  for (const file of files) {
    const json = await readJsonResilient<Record<string, unknown>>(file.path).catch(() => null);
    if (!json || !Object.keys(json).length) continue;
    out.push({
      source: file.source,
      keys: Object.keys(json),
      strictKnownMarketplaces: json.strictKnownMarketplaces !== undefined && json.strictKnownMarketplaces !== null,
      allowedMcpServers: Array.isArray(json.allowedMcpServers) ? json.allowedMcpServers.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))) : null,
      deniedMcpServers: Array.isArray(json.deniedMcpServers) ? json.deniedMcpServers.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))) : [],
    });
  }
  return out;
}

export async function buildInventory(audits: AuditCache): Promise<InventorySnapshot> {
  const started = performance.now();
  const warnings: string[] = [];
  const [profiles, prefs, reg, h] = await Promise.all([detectProfiles(), settings.get(), registry.get(), loadHasher(), audits.load()]);

  const configs = new Map(
    await Promise.all(
      profiles.map(async (p) => {
        try {
          return [p.id, await readJsonResilient<ClaudeConfig>(p.configFile)] as const;
        } catch (error) {
          warnings.push(`${p.configFile} could not be read: ${(error as Error).message}`);
          return [p.id, null] as const;
        }
      }),
    ),
  );

  // The plugin CLI is the slowest call in a scan; start it now and merge its answer at the end.
  const pluginStates = Promise.all(profiles.map(async (p) => [p.id, await fetchPluginStates(p)] as const)).then((e) => new Map(e));
  const [projects, pluginLists, lock] = await Promise.all([readProjects(configs, prefs.projects), Promise.all(profiles.map(discoverPlugins)), readVercelGlobalLock()]);
  const plugins = mergePlugins(pluginLists);
  const projectLocks = new Map(await Promise.all(projects.map(async (p) => [p, await readVercelProjectLock(p)] as const)));

  const sources = await collectSources(profiles, projects, plugins);
  const { skills: scannedList, warnings: scanWarnings } = await scanSkills(sources, {
    hasher: h,
    lock,
    projectLocks,
    installs: reg.installs,
    firstSeen: reg.firstSeen,
    plugins,
  });
  warnings.push(...scanWarnings);

  const [profileOverrides, projectOverrides, mcp, policy] = await Promise.all([
    Promise.all(profiles.map(async (p) => [p.id, await readOverrides(join(p.configDir, 'settings.json'))] as const)).then((e) => new Map(e)),
    Promise.all(
      projects.map(async (p) => [p, { ...(await readOverrides(join(p, '.claude', 'settings.json'))), ...(await readOverrides(join(p, '.claude', 'settings.local.json'))) }] as const),
    ).then((e) => new Map(e)),
    discoverMcp(profiles, configs, projects, plugins),
    readPolicy(profiles),
  ]);

  const activeProfile = profiles.find((p) => p.isActive) ?? profiles[0];
  const skills: SkillRecord[] = scannedList.map(({ record }) => {
    const overrideSource =
      record.projectPath && record.scope !== 'plugin'
        ? projectOverrides.get(record.projectPath)
        : profileOverrides.get(record.profileIds.includes(activeProfile?.id ?? '') ? activeProfile!.id : (record.profileIds[0] ?? ''));
    const staticAudit = record.contentHash ? audits.getStatic(record.contentHash) : null;
    const claude = reg.latestClaudeAudit[record.realPath];
    const review = reg.reviews[record.realPath];
    const scannerRuns = Object.entries(reg.latestScanner?.[record.realPath] ?? {}).filter(([, r]) => r.contentHash === record.contentHash);
    return {
      ...record,
      override: overrideSource?.[record.name] ?? 'on',
      audit: staticAudit
        ? {
            verdict: staticAudit.verdict,
            counts: staticAudit.counts,
            contentHash: staticAudit.contentHash,
            claude: claude ? { verdict: claude.verdict as Verdict, model: claude.model, at: claude.at, contentHash: claude.contentHash } : undefined,
            scanners: scannerRuns.length ? { verdict: scannerRuns.map(([, r]) => r.verdict as Verdict).reduce(worseVerdict), names: scannerRuns.map(([name]) => name) } : undefined,
          }
        : null,
      review: review ? { reviewedAt: review.reviewedAt, contentHash: review.contentHash, changedSince: review.contentHash !== record.contentHash } : null,
    };
  });

  applyPluginStates(plugins, await pluginStates);
  markShadowed(skills);
  const context = contextBudget(skills, plugins);

  // Remember when unknown-origin skills were first seen, so the date stays put after a copy or a restore.
  const newFirstSeen = skills.filter((s) => s.installedAtSource === 'first-seen' && s.installedAt && !reg.firstSeen[s.realPath]);
  if (newFirstSeen.length) {
    await registry.update((draft) => {
      for (const s of newFirstSeen) draft.firstSeen[s.realPath] = s.installedAt!;
    });
  }
  void saveHasher(h, new Set(scannedList.map((s) => s.record.realPath))).catch(() => undefined);

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return {
    inventory: {
      generatedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      profiles,
      skills,
      mcp,
      plugins,
      projects,
      policy,
      context,
      warnings,
    },
    scanned: new Map(scannedList.map((s) => [s.record.id, s])),
  };
}

function markShadowed(skills: SkillRecord[]): void {
  const groups = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    if (PRECEDENCE[skill.scope] === undefined) continue;
    const key = normalizeSkillName(skill.name);
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Project skills only collide with skills that load in that same project.
    for (const skill of group) {
      const winner = group
        .filter((other) => other !== skill && (!other.projectPath || other.projectPath === skill.projectPath))
        .sort((a, b) => PRECEDENCE[a.scope]! - PRECEDENCE[b.scope]!)[0];
      if (winner && PRECEDENCE[winner.scope]! < PRECEDENCE[skill.scope]!) {
        skill.shadowedBy = winner.id;
        skill.health.push({ code: 'shadowed', severity: 'medium', message: `A ${winner.scope} skill with the same name (${winner.path}) takes precedence, so this one does not load.` });
      }
    }
  }
}

/** What skill listings cost in every session: the always-loaded scopes, minus hidden and shadowed skills. */
function contextBudget(skills: SkillRecord[], plugins: PluginRecord[]): ContextBudget {
  const enabledPlugins = new Set(plugins.filter((p) => p.enabled !== false).map((p) => p.id));
  let totalChars = 0;
  let listed = 0;
  let overCap = 0;
  for (const s of skills) {
    if (s.contextChars > DESCRIPTION_CAP) overCap++;
    const always = s.scope === 'personal' || s.scope === 'managed' || s.scope === 'synced' || (s.scope === 'plugin' && !!s.pluginId && enabledPlugins.has(s.pluginId));
    if (!always || s.shadowedBy || s.meta.disableModelInvocation) continue;
    if (s.override === 'off' || s.override === 'user-invocable-only') continue;
    listed++;
    totalChars += s.name.length + (s.override === 'name-only' ? 0 : Math.min(s.contextChars, DESCRIPTION_CAP));
  }
  return { totalChars, perSkillCap: DESCRIPTION_CAP, overCap, listed };
}
