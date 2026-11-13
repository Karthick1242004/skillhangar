import { looksLikeSecretValue } from '../discovery/mcp';
import type { Inventory } from '../../shared/types';

export interface Manifest {
  kind: 'skillhangar-manifest';
  version: 1;
  generatedAt: string;
  skills: { name: string; scope: string; source: string; skillPath?: string; ref?: string; commit?: string }[];
  mcpServers: { name: string; scope: string; transport: string; command?: string; args?: string[]; url?: string; env?: string[]; headers?: string[] }[];
  untracked: string[];
}

/**
 * A portable description of a setup: where each skill came from and how each MCP server starts. It holds
 * no secret values: env and header entries are key names only, and secret-looking arguments are replaced.
 */
export function buildManifest(inventory: Inventory): Manifest {
  const skills: Manifest['skills'] = [];
  const untracked: string[] = [];
  for (const s of inventory.skills) {
    if (s.scope !== 'personal' && s.scope !== 'project') continue;
    if (s.provenance?.github) {
      skills.push({
        name: s.name,
        scope: s.scope,
        source: `${s.provenance.github.owner}/${s.provenance.github.repo}`,
        skillPath: s.provenance.skillPath,
        ref: s.provenance.ref,
        commit: s.provenance.commit,
      });
    } else {
      untracked.push(s.name);
    }
  }
  const mcpServers: Manifest['mcpServers'] = inventory.mcp
    .filter((m) => m.scope === 'user' || m.scope === 'project' || m.scope === 'local')
    .map((m) => ({
      name: m.name,
      scope: m.scope,
      transport: m.transport,
      command: m.command,
      args: m.args.length ? m.args.map((a) => (looksLikeSecretValue(a) ? '<redacted>' : a)) : undefined,
      url: m.url,
      env: m.env.length ? m.env.map((e) => e.key) : undefined,
      headers: m.headers.length ? m.headers.map((h) => h.key) : undefined,
    }));
  return { kind: 'skillhangar-manifest', version: 1, generatedAt: new Date().toISOString(), skills, mcpServers, untracked: [...new Set(untracked)].sort() };
}
