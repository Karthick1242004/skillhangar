import { z } from 'zod';
import { OpError } from './errors';
import type { Quarantine } from './quarantine';
import { installSkill } from './skills';
import { skillFolder } from '../enrich/service';
import { recordActivity } from '../store';
import { newId } from '../util/ids';
import type { InstallDestination, Inventory } from '../../shared/types';

export const ManifestSchema = z.object({
  kind: z.literal('skillhangar-manifest'),
  version: z.literal(1),
  generatedAt: z.string().optional(),
  skills: z.array(
    z.object({
      name: z.string().min(1),
      scope: z.string(),
      source: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'source must be owner/repo'),
      skillPath: z.string().optional(),
      ref: z.string().optional(),
      commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    }),
  ),
  mcpServers: z.array(
    z.object({
      name: z.string().regex(/^[\w.-]{1,64}$/),
      scope: z.string(),
      transport: z.string(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.array(z.string()).optional(),
      headers: z.array(z.string()).optional(),
    }),
  ),
  untracked: z.array(z.string()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export type PlanStep =
  | { kind: 'install-skill'; name: string; source: string; skillPath?: string; ref?: string; destination: InstallDestination }
  | { kind: 'skip-skill'; name: string; reason: string }
  | { kind: 'add-mcp'; name: string; command: string; needs: string[] }
  | { kind: 'skip-mcp'; name: string; reason: string };

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Works out what applying a manifest would do on this machine, without touching anything. Skills already
 * installed under the same name are skipped. MCP servers become `claude mcp add-json` commands with
 * `${KEY}` placeholders, because a manifest never carries secret values.
 */
export function planApply(manifest: Manifest, inventory: Inventory, options: { profileId: string; projectPath?: string }): PlanStep[] {
  const steps: PlanStep[] = [];
  const installed = new Set(inventory.skills.filter((s) => s.scope === 'personal' || (options.projectPath && s.projectPath === options.projectPath)).map((s) => s.name.toLowerCase()));
  for (const skill of manifest.skills) {
    if (installed.has(skill.name.toLowerCase())) {
      steps.push({ kind: 'skip-skill', name: skill.name, reason: 'already installed' });
      continue;
    }
    if (skill.scope === 'project' && !options.projectPath) {
      steps.push({ kind: 'skip-skill', name: skill.name, reason: 'project skill; pass --project <folder> to install it there' });
      continue;
    }
    steps.push({
      kind: 'install-skill',
      name: skill.name,
      source: skill.source,
      skillPath: skill.skillPath,
      // The exact commit from the source machine, so both machines run the same files.
      ref: skill.commit ?? skill.ref,
      destination: skill.scope === 'project' && options.projectPath ? { kind: 'project', path: options.projectPath } : { kind: 'profile', profileId: options.profileId },
    });
  }
  const servers = new Set(inventory.mcp.map((m) => m.name));
  for (const server of manifest.mcpServers) {
    if (servers.has(server.name)) {
      steps.push({ kind: 'skip-mcp', name: server.name, reason: 'already configured' });
      continue;
    }
    const config: Record<string, unknown> = server.transport === 'stdio' ? { command: server.command, args: server.args ?? [] } : { type: server.transport, url: server.url };
    if (server.env?.length) config.env = Object.fromEntries(server.env.map((k) => [k, `\${${k}}`]));
    if (server.headers?.length) config.headers = Object.fromEntries(server.headers.map((k) => [k, `\${${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`]));
    const scope = server.scope === 'user' ? 'user' : server.scope === 'project' ? 'project' : 'local';
    steps.push({
      kind: 'add-mcp',
      name: server.name,
      command: `claude mcp add-json ${shellQuote(server.name)} ${shellQuote(JSON.stringify(config))} --scope ${scope}`,
      needs: [...(server.env ?? []), ...(server.headers ?? [])],
    });
  }
  return steps;
}

export interface ApplyOutcome {
  name: string;
  ok: boolean;
  message: string;
}

/** Installs the planned skills, each through quarantine and the static audit. Dangerous ones need `force`. */
export async function executeApply(steps: PlanStep[], inventory: Inventory, quarantine: Quarantine, force: boolean): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const step of steps) {
    if (step.kind !== 'install-skill') continue;
    const [owner, repo] = step.source.split('/') as [string, string];
    const folder = skillFolder(step.skillPath);
    let item;
    try {
      item = await quarantine.fetch({ kind: 'github', owner, repo, ref: step.ref, subpath: folder || undefined, skill: folder ? undefined : step.name });
    } catch (error) {
      outcomes.push({ name: step.name, ok: false, message: (error as Error).message });
      continue;
    }
    try {
      const match = item.skills.find((s) => s.relPath === (folder ?? '')) ?? item.skills.find((s) => s.name === step.name) ?? item.skills[0]!;
      if (match.audit.verdict === 'dangerous' && !force) {
        outcomes.push({ name: step.name, ok: false, message: `skipped: the audit marked it dangerous (${match.audit.counts.critical} critical). Re-run with --force after reading it.` });
        continue;
      }
      const result = await installSkill({ item, relPath: match.relPath, dest: step.destination, mode: 'copy', acknowledgeRisk: force, profiles: inventory.profiles });
      await recordActivity({ id: newId('a_'), at: new Date().toISOString(), action: 'install', target: result.name, detail: `${step.source} to ${result.path} (from a manifest)`, undo: { kind: 'remove-install', ref: result.path } });
      outcomes.push({ name: step.name, ok: true, message: `installed at ${result.path} (${match.audit.verdict})` });
    } catch (error) {
      outcomes.push({ name: step.name, ok: false, message: error instanceof OpError ? error.message : (error as Error).message });
    } finally {
      await quarantine.discard(item.id);
    }
  }
  return outcomes;
}
