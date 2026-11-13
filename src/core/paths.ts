import { homedir } from 'node:os';
import { join } from 'node:path';

export function home(): string {
  return process.env.SKILLHANGAR_TEST_HOME ?? homedir();
}

/** Where Skillhangar keeps its own state. Never inside a Claude config folder. */
export function dataDir(): string {
  return process.env.SKILLHANGAR_HOME ?? join(home(), '.skillhangar');
}

export const dataPaths = {
  registry: () => join(dataDir(), 'registry.json'),
  settings: () => join(dataDir(), 'settings.json'),
  server: () => join(dataDir(), 'server.json'),
  activity: () => join(dataDir(), 'activity.jsonl'),
  usage: () => join(dataDir(), 'usage.jsonl'),
  hookScript: () => join(dataDir(), 'hook.mjs'),
  audits: () => join(dataDir(), 'audits'),
  snapshots: () => join(dataDir(), 'snapshots'),
  quarantine: () => join(dataDir(), 'quarantine'),
  trash: () => join(dataDir(), 'trash'),
  library: () => join(dataDir(), 'library'),
  backups: () => join(dataDir(), 'backups'),
  cache: (name: string) => join(dataDir(), 'cache', name),
  scratch: () => join(dataDir(), 'scratch'),
};

/** Vercel `skills` CLI global lock (v3). Honors XDG_STATE_HOME the same way the CLI does. */
export function vercelGlobalLockPaths(): string[] {
  const paths = [join(home(), '.agents', '.skill-lock.json')];
  if (process.env.XDG_STATE_HOME) paths.unshift(join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json'));
  return paths;
}

export function agentsSkillsDir(): string {
  return join(home(), '.agents', 'skills');
}

/** Managed (enterprise) settings directory per platform, as documented for Claude Code. */
export function managedDir(): string {
  if (process.env.SKILLHANGAR_MANAGED_DIR) return process.env.SKILLHANGAR_MANAGED_DIR;
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    default:
      return '/etc/claude-code';
  }
}
