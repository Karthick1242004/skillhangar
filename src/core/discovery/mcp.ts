import { join } from 'node:path';
import { managedDir } from '../paths';
import { readJsonResilient } from '../util/fs';
import { shortHash } from '../util/ids';
import { which } from '../util/proc';
import type { HealthIssue, McpEnvKey, McpPackage, McpScope, McpServerRecord, McpTransport, PluginRecord, Profile } from '../../shared/types';

interface RawServer {
  type?: string;
  command?: string;
  args?: unknown;
  env?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, unknown>;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, RawServer>;
  projects?: Record<string, { mcpServers?: Record<string, RawServer> }>;
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|session|cookie|bearer)/i;
const SECRET_VALUE = [
  /sk-ant-[\w-]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_\w{40,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[\w-]{10,}/,
  /\bAIza[\w-]{35}\b/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
];

/** A value is a reference, not a secret, when it only expands a variable (`${VAR}` or `$VAR`). */
function isReference(value: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}?$/.test(value.trim());
}

/** Paths, URLs without credentials and booleans or numbers are configuration, not secrets. */
function isPlainSetting(key: string, value: string): boolean {
  if (/_(FILE|PATH|DIR|DIRECTORY|URL|URI|HOST|PORT|ENDPOINT|REGION|MODE|LEVEL)$/i.test(key)) return true;
  const v = value.trim();
  if (/^(~|\.{0,2}\/|[a-zA-Z]:[\\/])/.test(v)) return true;
  if (/^(true|false|\d+(\.\d+)?)$/i.test(v)) return true;
  try {
    const url = new URL(v);
    return !url.password && ![...url.searchParams.keys()].some((k) => SECRET_KEY.test(k));
  } catch {
    return false;
  }
}

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE.some((re) => re.test(value));
}

/** Reduces env or header values to key names and flags. Values never leave this function. */
export function describeKeys(record: Record<string, unknown> | undefined): McpEnvKey[] {
  if (!record || typeof record !== 'object') return [];
  return Object.entries(record).map(([key, raw]) => {
    const value = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
    const set = value.trim().length > 0;
    const plaintextSecret = set && !isReference(value) && (looksLikeSecretValue(value) || (SECRET_KEY.test(key) && value.length >= 8 && !isPlainSetting(key, value)));
    return { key, set, plaintextSecret };
  });
}

/** Finds the package an npx/bunx/uvx/pipx/docker launch line runs, and whether its version is pinned. */
export function detectPackage(command: string | undefined, args: string[]): McpPackage | undefined {
  if (!command) return undefined;
  const bin = command.split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, '');
  const positional = (from: number) => {
    for (let i = from; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--package' || arg === '-p' || arg === '--from') return args[i + 1];
      if (!arg.startsWith('-')) return arg;
    }
    return undefined;
  };
  if (bin === 'npx' || bin === 'bunx' || (bin === 'pnpm' && args[0] === 'dlx') || (bin === 'yarn' && args[0] === 'dlx')) {
    const spec = positional(bin === 'pnpm' || bin === 'yarn' ? 1 : 0);
    if (!spec) return undefined;
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : undefined;
    return { ecosystem: 'npm', name, version, pinned: !!version && /^\d+\.\d+\.\d+/.test(version) };
  }
  if (bin === 'uvx' || (bin === 'pipx' && args[0] === 'run') || (bin === 'uv' && args[0] === 'tool' && args[1] === 'run')) {
    const spec = positional(bin === 'uvx' ? 0 : bin === 'pipx' ? 1 : 2);
    if (!spec) return undefined;
    const m = /^([A-Za-z0-9_.\-[\]]+?)(?:==([\w.]+)|@([\w.]+))?$/.exec(spec);
    if (!m) return undefined;
    const version = m[2] ?? m[3];
    return { ecosystem: 'pypi', name: m[1]!.replace(/\[.*\]$/, ''), version, pinned: !!version && version !== 'latest' };
  }
  if (bin === 'docker' && args[0] === 'run') {
    const valueFlags = new Set(['-e', '--env', '-v', '--volume', '--name', '--network', '-p', '--publish', '-w', '--workdir', '--env-file', '-u', '--user', '--mount', '--entrypoint', '--platform']);
    let image: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith('-')) {
        if (valueFlags.has(arg)) i++;
        continue;
      }
      image = arg;
      break;
    }
    if (!image) return undefined;
    const digest = image.includes('@sha256:');
    const tag = /:([\w.-]+)$/.exec(image.split('/').pop() ?? '')?.[1];
    return { ecosystem: 'docker', name: image.split('@')[0]!.replace(/:[\w.-]+$/, ''), version: digest ? image.split('@')[1] : tag, pinned: digest || (!!tag && tag !== 'latest') };
  }
  return undefined;
}

function transportOf(raw: RawServer): McpTransport {
  const t = (raw.type ?? '').toLowerCase();
  if (t === 'http' || t === 'streamable-http') return 'http';
  if (t === 'sse') return 'sse';
  if (t === 'ws' || t === 'websocket') return 'ws';
  if (!raw.command && raw.url) return 'http';
  return 'stdio';
}

async function buildRecord(
  name: string,
  raw: RawServer,
  scope: McpScope,
  profileIds: string[],
  extra: { projectPath?: string; pluginId?: string },
  needsAuth: Map<string, string>,
): Promise<McpServerRecord> {
  const transport = transportOf(raw);
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env = describeKeys(raw.env);
  const headers = describeKeys(raw.headers);
  const health: HealthIssue[] = [];
  let host: string | undefined;

  if (transport === 'stdio') {
    if (!raw.command) health.push({ code: 'mcp-no-command', severity: 'high', message: 'No command is configured, so the server cannot start.' });
    else if (!(await which(raw.command))) health.push({ code: 'mcp-command-missing', severity: 'high', message: `"${raw.command}" is not on PATH, so the server will fail to start.` });
    const secretArg = args.find((a) => looksLikeSecretValue(a));
    if (secretArg) health.push({ code: 'mcp-secret-in-args', severity: 'high', message: 'A command-line argument looks like a credential. Arguments are visible to every process on the machine.' });
  } else if (raw.url) {
    try {
      const url = new URL(raw.url);
      host = url.host;
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol === 'http:' && !local) health.push({ code: 'mcp-plain-http', severity: 'high', message: 'The server is reached over plain HTTP, so traffic and tokens travel unencrypted.' });
      if (transport === 'sse') health.push({ code: 'mcp-sse-deprecated', severity: 'low', message: 'The SSE transport is deprecated; prefer HTTP.' });
    } catch {
      health.push({ code: 'mcp-bad-url', severity: 'high', message: 'The URL does not parse.' });
    }
  }
  for (const key of [...env, ...headers]) {
    if (key.plaintextSecret) health.push({ code: 'mcp-plaintext-secret', severity: 'medium', message: `${key.key} is stored in plain text in the config file. Reference an environment variable instead.` });
  }
  const pkg = detectPackage(raw.command, args);
  if (pkg && !pkg.pinned && pkg.ecosystem !== 'docker') {
    health.push({ code: 'mcp-unpinned', severity: 'medium', message: `${pkg.name} is not pinned to a version, so every start can run new code from the registry.` });
  }

  const authAt = needsAuth.get(name);
  const auth: McpServerRecord['auth'] = authAt
    ? { state: 'needs-auth', checkedAt: authAt, source: 'cache' }
    : transport === 'stdio'
      ? { state: 'not-required', source: 'config' }
      : { state: 'unknown', source: 'config' };

  return {
    id: shortHash(`${scope}|${extra.projectPath ?? ''}|${extra.pluginId ?? ''}|${name}|${profileIds.join(',')}`),
    name,
    profileIds,
    scope,
    projectPath: extra.projectPath,
    pluginId: extra.pluginId,
    transport,
    command: raw.command,
    args,
    url: raw.url ? redactUrl(raw.url) : undefined,
    host,
    env,
    headers,
    package: pkg,
    auth,
    health,
  };
}

/** Removes credentials from a URL's user info and query string before it is shown. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, '***');
    return url.toString();
  } catch {
    return raw;
  }
}

async function readNeedsAuth(profile: Profile): Promise<Map<string, string>> {
  const cache = await readJsonResilient<Record<string, { timestamp?: number }>>(join(profile.configDir, 'mcp-needs-auth-cache.json')).catch(() => null);
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(cache ?? {})) {
    out.set(name, value?.timestamp ? new Date(value.timestamp).toISOString() : new Date(0).toISOString());
  }
  return out;
}

export async function discoverMcp(
  profiles: Profile[],
  configs: Map<string, ClaudeConfig | null>,
  projects: string[],
  plugins: PluginRecord[],
): Promise<McpServerRecord[]> {
  const records: McpServerRecord[] = [];
  const authByProfile = new Map(await Promise.all(profiles.map(async (p) => [p.id, await readNeedsAuth(p)] as const)));

  for (const profile of profiles) {
    const config = configs.get(profile.id);
    const needsAuth = authByProfile.get(profile.id)!;
    for (const [name, raw] of Object.entries(config?.mcpServers ?? {})) {
      records.push(await buildRecord(name, raw, 'user', [profile.id], {}, needsAuth));
    }
    for (const [projectPath, project] of Object.entries(config?.projects ?? {})) {
      for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) {
        records.push(await buildRecord(name, raw, 'local', [profile.id], { projectPath }, needsAuth));
      }
    }
  }

  const allIds = profiles.map((p) => p.id);
  const anyAuth = new Map([...authByProfile.values()].flatMap((m) => [...m]));
  for (const projectPath of projects) {
    const file = await readJsonResilient<{ mcpServers?: Record<string, RawServer> }>(join(projectPath, '.mcp.json')).catch(() => null);
    for (const [name, raw] of Object.entries(file?.mcpServers ?? {})) {
      records.push(await buildRecord(name, raw, 'project', allIds, { projectPath }, anyAuth));
    }
  }

  const managed = await readJsonResilient<{ mcpServers?: Record<string, RawServer> }>(join(managedDir(), 'managed-mcp.json')).catch(() => null);
  for (const [name, raw] of Object.entries(managed?.mcpServers ?? {})) {
    records.push(await buildRecord(name, raw, 'managed', allIds, {}, anyAuth));
  }

  const seenPluginPaths = new Set<string>();
  for (const plugin of plugins) {
    if (seenPluginPaths.has(plugin.installPath)) continue;
    seenPluginPaths.add(plugin.installPath);
    const file = await readJsonResilient<{ mcpServers?: Record<string, RawServer> }>(join(plugin.installPath, '.mcp.json')).catch(() => null);
    for (const [name, raw] of Object.entries(file?.mcpServers ?? {})) {
      records.push(await buildRecord(name, raw, 'plugin', plugin.profileIds, { pluginId: plugin.id }, anyAuth));
    }
  }
  return records;
}
