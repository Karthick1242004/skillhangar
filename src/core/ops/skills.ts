import { rename, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { diffDirs } from './diff';
import { OpError } from './errors';
import { gitTreeSha } from './gittree';
import type { Quarantine, QuarantineRecord, QuarantineSkillInternal } from './quarantine';
import { editSettingsFile } from './settings-file';
import { vault } from './vault';
import type { AuditCache } from '../audit/cache';
import { runStaticAudit } from '../audit/static';
import { profileEnv } from '../discovery/profiles';
import type { ScannedSkill } from '../discovery/skills';
import { skillFolder } from '../enrich/service';
import { dataPaths } from '../paths';
import { registry, type InstallRecord } from '../store';
import { TreeHasher, walkTree } from '../tree';
import { copyDir, ensureDir, exists, isDirectory, lstatOrNull, realpathOrNull } from '../util/fs';
import { safeSegment } from '../util/ids';
import { run, which } from '../util/proc';
import type { Finding, InstallDestination, Profile, Provenance, SkillOverride, SkillRecord, StaticAudit, TrashItem, UpdatePreview } from '../../shared/types';

/** The `skills` CLI version Skillhangar runs for lock-tracked updates; pinned so a new publish cannot change what runs. */
export const SKILLS_CLI = 'skills@1.8.1';

const REMOVABLE: SkillRecord['scope'][] = ['personal', 'project', 'legacy-command', 'agents-store'];

export async function destinationDir(dest: InstallDestination, profiles: Profile[]): Promise<string> {
  if (dest.kind === 'profile') {
    const profile = profiles.find((p) => p.id === dest.profileId);
    if (!profile) throw new OpError('NOT_FOUND', `No Claude profile named "${dest.profileId}".`);
    return profile.skillsDir;
  }
  if (!dest.path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(dest.path)) throw new OpError('INVALID', 'The project folder must be an absolute path.');
  if (!(await isDirectory(dest.path))) throw new OpError('NOT_FOUND', `${dest.path} is not a folder.`);
  return join(dest.path, '.claude', 'skills');
}

function provenanceFor(item: QuarantineRecord, skill: QuarantineSkillInternal): Provenance {
  if (item.source.kind === 'github') {
    const { owner, repo, ref } = item.source;
    return {
      kind: 'skillhangar',
      source: `${owner}/${repo}`,
      github: { owner, repo },
      ref,
      commit: item.commit,
      skillPath: skill.relPath || undefined,
      treeSha: skill.treeSha,
      url: `https://github.com/${owner}/${repo}`,
      updatedAt: new Date().toISOString(),
    };
  }
  return { kind: 'skillhangar', source: `local folder ${item.source.path}`, treeSha: skill.treeSha, updatedAt: new Date().toISOString() };
}

export async function installSkill(params: {
  item: QuarantineRecord;
  relPath: string;
  dest: InstallDestination;
  mode: 'copy' | 'symlink';
  acknowledgeRisk: boolean;
  profiles: Profile[];
}): Promise<{ path: string; name: string; provenance: Provenance }> {
  const skill = params.item.skills.find((s) => s.relPath === params.relPath);
  if (!skill) throw new OpError('NOT_FOUND', 'That skill is not in this download.');
  if (skill.audit.verdict === 'dangerous' && !params.acknowledgeRisk) {
    throw new OpError('RISK_NOT_ACKNOWLEDGED', 'The audit marked this skill dangerous. Confirm that you have read the findings to install it anyway.');
  }
  const targetRoot = await destinationDir(params.dest, params.profiles);
  // A skill at the root of its source takes the source's own name (the repository, or the local folder).
  const rootName = params.item.source.kind === 'github' ? (params.item.source.subpath ? basename(params.item.source.subpath) : params.item.source.repo) : basename(params.item.source.path);
  const folderName = safeSegment(skill.relPath ? basename(skill.dir) : rootName);
  const target = join(targetRoot, folderName);
  if (await lstatOrNull(target)) throw new OpError('EXISTS', `${target} already exists. Remove it first, or use Update on the installed skill.`);
  await ensureDir(targetRoot);

  const provenance = provenanceFor(params.item, skill);
  if (params.mode === 'symlink') {
    // One shared copy in the library; each install is a link to it, so several projects stay in step.
    const library = join(dataPaths.library(), safeSegment(`${provenance.source}-${folderName}-${(params.item.commit ?? skill.contentHash).slice(0, 10)}`));
    if (!(await exists(library))) await copyDir(skill.dir, library);
    await symlink(library, target, 'dir');
  } else {
    await copyDir(skill.dir, target);
  }
  const real = (await realpathOrNull(target)) ?? target;
  const now = new Date().toISOString();
  const record: InstallRecord = { name: skill.name, path: target, provenance, installedAt: now, updatedAt: now, contentHash: skill.contentHash, mode: params.mode };
  await registry.update((draft) => {
    draft.installs[real] = record;
  });
  return { path: target, name: skill.name, provenance };
}

export async function removeSkill(skill: SkillRecord): Promise<TrashItem> {
  if (!REMOVABLE.includes(skill.scope)) {
    const how =
      skill.scope === 'plugin'
        ? 'Disable or uninstall its plugin instead.'
        : skill.scope === 'synced'
          ? 'Turn it off on claude.ai; a deleted synced skill is downloaded again on the next sync.'
          : 'It is managed by your organization.';
    throw new OpError('NOT_SUPPORTED', `This ${skill.scope} skill cannot be removed here. ${how}`);
  }
  // A symlinked skill loses only its link; the shared copy it points at stays where it is.
  const item = await vault.trash(skill.path, 'skill', skill.name);
  await registry.update((draft) => {
    delete draft.installs[skill.realPath];
  });
  return item;
}

export interface OverrideChange {
  path: string;
  name: string;
  previous: SkillOverride | undefined;
  next: SkillOverride;
}

/**
 * Sets `skillOverrides` for a skill: in the profile's settings.json for personal skills, or in the
 * project's `.claude/settings.local.json` (where the /skills menu writes) for project skills. "on" removes
 * the entry, since an absent entry means on.
 */
export async function setOverride(skill: SkillRecord, value: SkillOverride, profiles: Profile[]): Promise<OverrideChange> {
  if (skill.scope === 'plugin') throw new OpError('NOT_SUPPORTED', 'skillOverrides does not apply to plugin skills. Disable the plugin instead.');
  if (skill.scope === 'agents-store') throw new OpError('NOT_SUPPORTED', 'This skill is not linked into Claude Code, so there is nothing to switch off.');
  let path: string;
  if (skill.projectPath) path = join(skill.projectPath, '.claude', 'settings.local.json');
  else {
    const profile = profiles.find((p) => p.isActive && skill.profileIds.includes(p.id)) ?? profiles.find((p) => skill.profileIds.includes(p.id));
    if (!profile) throw new OpError('NOT_FOUND', 'No profile loads this skill.');
    path = join(profile.configDir, 'settings.json');
  }
  return writeOverride(path, skill.name, value);
}

export async function writeOverride(path: string, name: string, value: SkillOverride | undefined): Promise<OverrideChange> {
  let previous: SkillOverride | undefined;
  await editSettingsFile<{ skillOverrides?: Record<string, SkillOverride> }>(path, (json) => {
    previous = json.skillOverrides?.[name];
    if (value === undefined || value === 'on') {
      if (json.skillOverrides) {
        delete json.skillOverrides[name];
        if (!Object.keys(json.skillOverrides).length) delete json.skillOverrides;
      }
    } else {
      json.skillOverrides = { ...(json.skillOverrides ?? {}), [name]: value };
    }
  });
  return { path, name, previous, next: value ?? 'on' };
}

export interface PreparedUpdate extends UpdatePreview {
  sourceDir: string;
  treeSha: string;
  commit?: string;
}

function seriousKey(f: Finding): string {
  return `${f.ruleId}|${f.file}|${f.evidence ?? ''}`;
}

export async function prepareUpdate(skill: SkillRecord, scanned: ScannedSkill | undefined, quarantine: Quarantine, audits: AuditCache, hasher: TreeHasher): Promise<PreparedUpdate> {
  const p = skill.provenance;
  if (!p?.github) throw new OpError('NOT_SUPPORTED', 'This skill has no GitHub source on record, so there is nothing to update from. Use "Trace origin" first.');
  if (p.kind === 'plugin') throw new OpError('NOT_SUPPORTED', 'Plugin skills update with their plugin.');
  if (skill.isSymlink && p.kind !== 'vercel-lock' && p.kind !== 'skillhangar') throw new OpError('NOT_SUPPORTED', 'This skill is a link to a folder another tool manages.');
  const folder = p.kind === 'git' ? undefined : skillFolder(p.skillPath);
  const item = await quarantine.fetch({ kind: 'github', owner: p.github.owner, repo: p.github.repo, ref: p.kind === 'git' ? undefined : p.ref, subpath: folder || undefined });
  const upstream = item.skills.find((s) => s.relPath === (folder ?? '')) ?? (item.skills.length === 1 ? item.skills[0] : undefined);
  if (!upstream) throw new OpError('NOT_FOUND', 'The skill folder was not found upstream; it may have moved or been deleted.');

  let before: StaticAudit | null = audits.getStatic(skill.contentHash);
  if (!before) {
    const tree = scanned?.tree ?? (await walkTree(skill.realPath));
    before = await runStaticAudit(skill.realPath, tree, scanned?.frontmatter ?? {}, skill.contentHash);
    await audits.putStatic(before);
  }
  const known = new Set(before.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').map(seriousKey));
  const newSerious = upstream.audit.findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && !known.has(seriousKey(f)));

  return {
    skillId: skill.id,
    quarantineId: item.id,
    method: p.kind === 'vercel-lock' || p.kind === 'vercel-project-lock' ? 'vercel-cli' : p.kind === 'git' ? 'git' : 'skillhangar',
    fromHash: skill.contentHash,
    toHash: upstream.contentHash,
    diff: await diffDirs(skill.realPath, upstream.dir, hasher),
    auditBefore: before,
    auditAfter: upstream.audit,
    newSerious,
    sourceDir: upstream.dir,
    treeSha: upstream.treeSha,
    commit: item.commit,
  };
}

export async function applyUpdate(skill: SkillRecord, prepared: PreparedUpdate, acknowledgeRisk: boolean, profiles: Profile[]): Promise<{ snapshotId: string; warning?: string }> {
  if (prepared.newSerious.length && !acknowledgeRisk) {
    throw new OpError('RISK_NOT_ACKNOWLEDGED', `The new version adds ${prepared.newSerious.length} serious finding(s). Read them and confirm to update anyway.`);
  }
  const snapshot = await vault.snapshot(skill.realPath, skill.name, 'Before update', skill.contentHash);
  let warning: string | undefined;

  if (prepared.method === 'vercel-cli') {
    const npx = await which('npx');
    if (!npx) throw new OpError('CLI_FAILED', 'npx is not on PATH, so the skills CLI cannot run.');
    const project = skill.provenance?.kind === 'vercel-project-lock';
    const profile = profiles.find((p) => skill.profileIds.includes(p.id));
    const result = await run(npx, ['-y', SKILLS_CLI, 'update', skill.folderName, project ? '-p' : '-g', '-y'], {
      cwd: project ? skill.projectPath : undefined,
      env: profile ? profileEnv(profile) : process.env,
      timeoutMs: 180_000,
    });
    if (result.code !== 0) throw new OpError('CLI_FAILED', `skills update failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
    const after = await gitTreeSha(skill.realPath).catch(() => null);
    if (after && after !== prepared.treeSha) warning = 'The skills CLI installed a different version from the one previewed (upstream changed in between). Review the skill again.';
  } else if (prepared.method === 'git') {
    const git = await which('git');
    if (!git) throw new OpError('CLI_FAILED', 'git is not on PATH.');
    const result = await run(git, ['-C', skill.realPath, 'pull', '--ff-only'], { timeoutMs: 120_000 });
    if (result.code !== 0) throw new OpError('CLI_FAILED', `git pull failed: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`);
  } else {
    // Swap folders: stage the new copy beside the old one, then two renames, so the skill is never half-written.
    const staging = `${skill.realPath}.skillhangar-${Date.now()}`;
    await copyDir(prepared.sourceDir, staging);
    const old = `${staging}.old`;
    await rename(skill.realPath, old);
    try {
      await rename(staging, skill.realPath);
    } catch (error) {
      await rename(old, skill.realPath);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await rm(old, { recursive: true, force: true });
    await registry.update((draft) => {
      const record = draft.installs[skill.realPath];
      if (record) {
        record.updatedAt = new Date().toISOString();
        record.contentHash = prepared.toHash;
        record.provenance = { ...record.provenance, commit: prepared.commit, treeSha: prepared.treeSha, updatedAt: record.updatedAt };
      }
    });
  }
  return { snapshotId: snapshot.id, warning };
}

/** Records an origin for a skill that had none, so update checks can work from now on. */
export async function linkOrigin(skill: SkillRecord, origin: { owner: string; repo: string; skillPath: string }): Promise<Provenance> {
  const treeSha = await gitTreeSha(skill.realPath);
  const provenance: Provenance = {
    kind: 'skillhangar',
    source: `${origin.owner}/${origin.repo}`,
    github: { owner: origin.owner, repo: origin.repo },
    skillPath: origin.skillPath,
    treeSha,
    url: `https://github.com/${origin.owner}/${origin.repo}`,
    updatedAt: new Date().toISOString(),
  };
  await registry.update((draft) => {
    draft.installs[skill.realPath] = {
      name: skill.name,
      path: skill.path,
      provenance,
      installedAt: skill.installedAt ?? new Date().toISOString(),
      updatedAt: provenance.updatedAt!,
      contentHash: skill.contentHash,
      mode: skill.isSymlink ? 'symlink' : 'copy',
    };
  });
  return provenance;
}

