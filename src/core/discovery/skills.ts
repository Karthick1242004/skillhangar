import { lstat, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { descriptionOf, parseSkillFile, stringField, toSkillMeta } from './frontmatter';
import { provenanceFromFrontmatter, provenanceFromLock, readGitProvenance, type LockIndex } from './provenance';
import { agentsSkillsDir, managedDir } from '../paths';
import type { InstallRecord } from '../store';
import { summarizeFiles, walkTree, type TreeHasher, type TreeWalk } from '../tree';
import { exists, isDirectory, readTextCapped, realpathOrNull, safeReaddir } from '../util/fs';
import { shortHash } from '../util/ids';
import { mapLimit } from '../util/limit';
import { DESCRIPTION_CAP, type HealthIssue, type PluginRecord, type Profile, type Provenance, type SkillRecord, type SkillScope } from '../../shared/types';

export interface SkillSource {
  dir: string;
  scope: SkillScope;
  profileIds: string[];
  projectPath?: string;
  pluginId?: string;
  /** Folders of SKILL.md, or a legacy `commands/` folder of single `.md` files. */
  layout: 'skills' | 'commands';
}

/** A scanned skill plus the private data later stages need (never sent to the UI). */
export interface ScannedSkill {
  record: Omit<SkillRecord, 'override' | 'audit' | 'review' | 'shadowedBy'>;
  tree: TreeWalk | null;
  frontmatter: Record<string, unknown>;
}

export interface ScanContext {
  hasher: TreeHasher;
  lock: LockIndex;
  projectLocks: Map<string, Map<string, { source?: string }>>;
  installs: Record<string, InstallRecord>;
  firstSeen: Record<string, string>;
  plugins: PluginRecord[];
}

const MAX_SKILL_MD = 2 * 1024 * 1024;
const INVALID_NAME = /[\u0000-\u001F\u007F\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\uE000-\uF8FF<>]/;

export async function collectSources(profiles: Profile[], projects: string[], plugins: PluginRecord[]): Promise<SkillSource[]> {
  const sources: SkillSource[] = [];
  const managedSkills = join(managedDir(), '.claude', 'skills');
  if (await isDirectory(managedSkills)) sources.push({ dir: managedSkills, scope: 'managed', profileIds: profiles.map((p) => p.id), layout: 'skills' });

  // Profiles that share one skills folder (through a symlink) produce one source listing both profiles.
  const byReal = new Map<string, SkillSource>();
  const personalReal = new Set<string>();
  for (const profile of profiles) {
    const real = profile.skillsRealDir;
    if (!real) continue;
    personalReal.add(real);
    const existing = byReal.get(real);
    if (existing) existing.profileIds.push(profile.id);
    else byReal.set(real, { dir: profile.skillsDir, scope: 'personal', profileIds: [profile.id], layout: 'skills' });
  }
  for (const source of byReal.values()) {
    sources.push(source);
    sources.push({ ...source, dir: join(source.dir, 'synced'), scope: 'synced', profileIds: [...source.profileIds] });
  }

  const commandsByReal = new Map<string, SkillSource>();
  for (const profile of profiles) {
    const dir = join(profile.configDir, 'commands');
    const real = await realpathOrNull(dir);
    if (!real) continue;
    const existing = commandsByReal.get(real);
    if (existing) existing.profileIds.push(profile.id);
    else commandsByReal.set(real, { dir, scope: 'legacy-command', profileIds: [profile.id], layout: 'commands' });
  }
  sources.push(...commandsByReal.values());

  for (const project of projects) {
    const skillsDir = join(project, '.claude', 'skills');
    const real = await realpathOrNull(skillsDir);
    if (real && !personalReal.has(real)) sources.push({ dir: skillsDir, scope: 'project', profileIds: profiles.map((p) => p.id), projectPath: project, layout: 'skills' });
    const commandsDir = join(project, '.claude', 'commands');
    const commandsReal = await realpathOrNull(commandsDir);
    if (commandsReal && !commandsByReal.has(commandsReal)) sources.push({ dir: commandsDir, scope: 'legacy-command', profileIds: profiles.map((p) => p.id), projectPath: project, layout: 'commands' });
  }

  const seenPlugins = new Set<string>();
  for (const plugin of plugins) {
    const dir = join(plugin.installPath, 'skills');
    if (seenPlugins.has(dir)) continue;
    seenPlugins.add(dir);
    if (await isDirectory(dir)) sources.push({ dir, scope: 'plugin', profileIds: plugin.profileIds, pluginId: plugin.id, projectPath: plugin.projectPath, layout: 'skills' });
  }

  if (await isDirectory(agentsSkillsDir())) sources.push({ dir: agentsSkillsDir(), scope: 'agents-store', profileIds: [], layout: 'skills' });
  return sources;
}

/** Lists candidate entries of one source: skill folders (or links to them), or `.md` command files. */
async function listEntries(source: SkillSource): Promise<string[]> {
  const entries = await safeReaddir(source.dir);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(source.dir, entry.name);
    if (source.layout === 'commands') {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) out.push(full);
      continue;
    }
    if (source.scope === 'personal' && entry.name.toLowerCase() === 'synced') continue;
    if (entry.isDirectory() || entry.isSymbolicLink()) out.push(full);
  }
  return out;
}

export async function scanSkills(sources: SkillSource[], ctx: ScanContext): Promise<{ skills: ScannedSkill[]; warnings: string[] }> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const jobs: { source: SkillSource; path: string }[] = [];
  for (const source of sources) for (const path of await listEntries(source)) jobs.push({ source, path });

  // Resolve real paths first so the first source in precedence order owns a skill that several sources reach.
  const resolved = await mapLimit(jobs, 32, async (job) => ({ ...job, real: await realpathOrNull(job.path) }));
  const unique = resolved.filter((job) => {
    const key = job.real ?? job.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const scanned = await mapLimit(unique, 12, async (job) => {
    try {
      return await scanOne(job.source, job.path, job.real, ctx);
    } catch (error) {
      warnings.push(`Could not read ${job.path}: ${(error as Error).message}`);
      return null;
    }
  });
  return { skills: scanned.filter((s): s is ScannedSkill => s !== null), warnings };
}

async function scanOne(source: SkillSource, path: string, real: string | null, ctx: ScanContext): Promise<ScannedSkill | null> {
  const link = await lstat(path).catch(() => null);
  const isSymlink = !!link?.isSymbolicLink();
  const isCommand = source.layout === 'commands';
  const folderName = isCommand ? basename(path, '.md') : basename(path);
  const health: HealthIssue[] = [];

  if (!real) {
    if (!isSymlink) return null;
    health.push({ code: 'broken-link', severity: 'high', message: 'This entry is a symlink whose target no longer exists, so the skill does not load.' });
    return {
      record: emptyRecord(source, path, path, folderName, isSymlink, health),
      tree: null,
      frontmatter: {},
    };
  }

  const skillMdPath = isCommand ? real : join(real, 'SKILL.md');
  if (!isCommand && !(await exists(skillMdPath))) return null;
  const file = await readTextCapped(skillMdPath, MAX_SKILL_MD);
  if (!file) return null;
  const parsed = parseSkillFile(file.text);
  const meta = toSkillMeta(parsed.data);
  const description = descriptionOf(parsed);
  const whenToUse = stringField(parsed.data, 'when_to_use');
  const name = stringField(parsed.data, 'name') ?? folderName;

  let tree: TreeWalk | null = null;
  let contentHash: string;
  let files: SkillRecord['files'];
  if (isCommand) {
    const info = await stat(real);
    contentHash = await ctx.hasher.fileHash(real, info.size, info.mtimeMs);
    files = { count: 1, bytes: info.size, scripts: 0, binaries: 0, vendored: { dirs: [], files: 0 } };
  } else {
    tree = await walkTree(real);
    contentHash = await ctx.hasher.treeHash(real, tree);
    files = summarizeFiles(tree);
  }

  if (!parsed.hasFrontmatter && !isCommand) health.push({ code: 'no-frontmatter', severity: 'low', message: 'SKILL.md has no frontmatter, so Claude falls back to the first line of the body as the description.' });
  if (parsed.error) health.push({ code: 'frontmatter-invalid', severity: 'medium', message: `Frontmatter is not valid YAML (${parsed.error}). Claude Code reads it leniently, but other agents and tools may not; quote the value that holds a colon.` });
  if (!description) health.push({ code: 'no-description', severity: 'medium', message: 'No description, so Claude has nothing to decide when to use this skill.' });
  if (INVALID_NAME.test(folderName) || INVALID_NAME.test(name)) health.push({ code: 'name-invalid-chars', severity: 'high', message: 'The name holds an invisible, control or direction-changing character, so Claude Code refuses to load or list it.' });
  if (!isCommand && folderName !== name && source.scope !== 'plugin') health.push({ code: 'name-mismatch', severity: 'info', message: `Frontmatter name "${name}" differs from the folder name "${folderName}".` });
  if (folderName.toLowerCase() === 'synced' && source.scope !== 'synced') health.push({ code: 'reserved-name', severity: 'medium', message: 'A skill folder named "synced" is skipped because the name is reserved for claude.ai sync.' });
  const contextChars = description.length + (whenToUse ? whenToUse.length + 1 : 0);
  if (contextChars > DESCRIPTION_CAP) health.push({ code: 'description-truncated', severity: 'medium', message: `Description and when_to_use run to ${contextChars} characters; Claude sees only the first ${DESCRIPTION_CAP}.` });
  if (meta.unknownKeys.length) health.push({ code: 'unknown-keys', severity: 'info', message: `Claude Code ignores these frontmatter keys: ${meta.unknownKeys.join(', ')}.` });
  if (source.scope === 'agents-store') health.push({ code: 'not-linked', severity: 'info', message: 'Stored by the skills CLI but not linked into any Claude Code skills folder, so Claude does not load it.' });
  if (file.truncated) health.push({ code: 'skill-md-large', severity: 'low', message: 'SKILL.md is larger than 2 MB; only the first 2 MB was read.' });

  const provenance = await resolveProvenance(source, real, folderName, parsed.data, ctx);
  const { installedAt, installedAtSource } = await resolveInstallDate(source, path, real, folderName, provenance, ctx);

  return {
    record: {
      id: shortHash(real),
      name,
      folderName,
      description,
      whenToUse,
      scope: source.scope,
      profileIds: [...source.profileIds],
      projectPath: source.projectPath,
      pluginId: source.pluginId,
      path,
      realPath: real,
      isSymlink,
      meta,
      files,
      contentHash,
      installedAt,
      installedAtSource,
      provenance,
      contextChars,
      health,
    },
    tree,
    frontmatter: parsed.data,
  };
}

function emptyRecord(source: SkillSource, path: string, real: string, folderName: string, isSymlink: boolean, health: HealthIssue[]): ScannedSkill['record'] {
  return {
    id: shortHash(real),
    name: folderName,
    folderName,
    description: '',
    scope: source.scope,
    profileIds: [...source.profileIds],
    projectPath: source.projectPath,
    pluginId: source.pluginId,
    path,
    realPath: real,
    isSymlink,
    meta: toSkillMeta({}),
    files: { count: 0, bytes: 0, scripts: 0, binaries: 0, vendored: { dirs: [], files: 0 } },
    contentHash: '',
    installedAt: null,
    installedAtSource: null,
    provenance: null,
    contextChars: 0,
    health,
  };
}

async function resolveProvenance(source: SkillSource, real: string, folderName: string, frontmatter: Record<string, unknown>, ctx: ScanContext): Promise<Provenance | null> {
  const install = ctx.installs[real];
  if (install) return install.provenance;
  if (source.scope === 'personal' || source.scope === 'agents-store') {
    const entry = ctx.lock.global.get(folderName.toLowerCase());
    if (entry) return provenanceFromLock(entry, 'vercel-lock');
  }
  if (source.projectPath) {
    const entry = ctx.projectLocks.get(source.projectPath)?.get(folderName.toLowerCase());
    if (entry) return provenanceFromLock(entry, 'vercel-project-lock');
  }
  if (source.pluginId) {
    const plugin = ctx.plugins.find((p) => p.id === source.pluginId);
    if (plugin) {
      const repo = plugin.marketplaceRepo && /^[\w.-]+\/[\w.-]+$/.test(plugin.marketplaceRepo) ? plugin.marketplaceRepo.split('/') : null;
      return {
        kind: 'plugin',
        source: `${plugin.name}@${plugin.marketplace}`,
        github: repo ? { owner: repo[0]!, repo: repo[1]! } : undefined,
        commit: plugin.gitCommitSha,
        updatedAt: plugin.lastUpdated,
      };
    }
  }
  return (await readGitProvenance(real)) ?? provenanceFromFrontmatter(frontmatter);
}

async function resolveInstallDate(
  source: SkillSource,
  path: string,
  real: string,
  folderName: string,
  provenance: Provenance | null,
  ctx: ScanContext,
): Promise<{ installedAt: string | null; installedAtSource: SkillRecord['installedAtSource'] }> {
  const install = ctx.installs[real];
  if (install) return { installedAt: install.installedAt, installedAtSource: 'skillhangar' };
  if (provenance?.kind === 'vercel-lock') {
    const entry = ctx.lock.global.get(folderName.toLowerCase());
    if (entry?.installedAt) return { installedAt: entry.installedAt, installedAtSource: 'lock' };
  }
  if (source.pluginId) {
    const plugin = ctx.plugins.find((p) => p.id === source.pluginId);
    if (plugin?.installedAt) return { installedAt: plugin.installedAt, installedAtSource: 'plugin' };
  }
  const known = ctx.firstSeen[real];
  if (known) return { installedAt: known, installedAtSource: 'first-seen' };
  // Birth time of the entry in the skills folder: when it appeared there, which is the closest thing to an install date.
  const info = await lstat(path).catch(() => null);
  const birth = info && info.birthtimeMs > 0 ? info.birthtime : info?.mtime;
  return { installedAt: birth ? birth.toISOString() : null, installedAtSource: birth ? 'first-seen' : null };
}
