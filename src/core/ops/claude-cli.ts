import { homedir } from 'node:os';
import { OpError } from './errors';
import { profileEnv } from '../discovery/profiles';
import { run, which } from '../util/proc';
import type { McpAuthState, McpScope, PluginRecord, Profile } from '../../shared/types';

/**
 * Every change to MCP servers and plugins goes through the `claude` CLI, never by editing `.claude.json`
 * directly: Claude Code rewrites that file constantly and owns its format.
 */
async function claude(profile: Profile, args: string[], cwd?: string, timeoutMs = 60_000) {
  const bin = await which('claude');
  if (!bin) throw new OpError('CLI_FAILED', 'The claude command is not on PATH.');
  const result = await run(bin, args, { env: profileEnv(profile), cwd: cwd ?? homedir(), timeoutMs });
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' ');
    throw new OpError('CLI_FAILED', message || `claude ${args[0]} ${args[1]} failed with code ${result.code}`);
  }
  return result.stdout;
}

const SERVER_NAME = /^[\w.-]{1,64}$/;

export async function addMcpServer(profile: Profile, name: string, config: Record<string, unknown>, scope: Exclude<McpScope, 'managed' | 'plugin'>, projectPath?: string): Promise<void> {
  if (!SERVER_NAME.test(name)) throw new OpError('INVALID', 'Server names may use letters, digits, dot, dash and underscore.');
  if (scope !== 'user' && !projectPath) throw new OpError('INVALID', `A ${scope} server needs a project folder.`);
  await claude(profile, ['mcp', 'add-json', name, JSON.stringify(config), '--scope', scope], scope === 'user' ? undefined : projectPath);
}

export async function removeMcpServer(profile: Profile, name: string, scope: McpScope, projectPath?: string): Promise<void> {
  if (scope === 'managed' || scope === 'plugin' || scope === 'connector') {
    throw new OpError('NOT_SUPPORTED', scope === 'plugin' ? 'This server comes from a plugin; disable the plugin instead.' : scope === 'connector' ? 'claude.ai connectors are managed in your claude.ai settings.' : 'Managed servers are set by your organization.');
  }
  await claude(profile, ['mcp', 'remove', name, '--scope', scope], scope === 'user' ? undefined : projectPath);
}

export type PluginAction = 'enable' | 'disable' | 'update' | 'uninstall';

export async function pluginAction(profile: Profile, plugin: PluginRecord, action: PluginAction): Promise<void> {
  const scope = ['user', 'project', 'local'].includes(plugin.scope) ? plugin.scope : undefined;
  const args = ['plugin', action, plugin.id];
  if (scope && action !== 'update') args.push('--scope', scope);
  await claude(profile, args, plugin.projectPath, action === 'update' ? 180_000 : 60_000);
}

export interface ProbeResult {
  statuses: Record<string, McpAuthState>;
  /** What each server points at (a URL or a command line), as `claude mcp list` prints it. */
  targets: Record<string, string>;
  checkedAt: string;
}

/**
 * Asks Claude Code itself which MCP servers connect. `claude mcp list` starts each server, runs its health
 * check and prints one line per server ("name: target - ✔ Connected"); no model is called. Run in the
 * folder whose project and local servers should be checked.
 */
export async function probeMcp(profile: Profile, cwd: string): Promise<ProbeResult> {
  const output = await claude(profile, ['mcp', 'list'], cwd, 90_000);
  const statuses: Record<string, McpAuthState> = {};
  const targets: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const split = line.lastIndexOf(' - ');
    const colon = line.indexOf(': ');
    if (split < 0 || colon < 0 || colon > split) continue;
    const name = line.slice(0, colon).trim();
    const status = line.slice(split + 3).replace(/^[^A-Za-z]+/, '').trim();
    if (name) {
      statuses[name] = normalizeStatus(status);
      targets[name] = line.slice(colon + 2, split).trim();
    }
  }
  if (!Object.keys(statuses).length && !/No MCP servers/i.test(output)) {
    throw new OpError('CLI_FAILED', 'Could not read server status from `claude mcp list`.');
  }
  return { statuses, targets, checkedAt: new Date().toISOString() };
}

function normalizeStatus(status: string): McpAuthState {
  const s = status.toLowerCase();
  if (s.startsWith('connected')) return 'connected';
  if (s.includes('auth')) return 'needs-auth';
  if (s.startsWith('pending') || s.startsWith('connecting')) return 'pending';
  if (s.includes('fail') || s.includes('error') || s.includes('disconnected')) return 'failed';
  return 'unknown';
}
