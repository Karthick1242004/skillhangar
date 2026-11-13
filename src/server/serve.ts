import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { Hangar } from './hangar';
import { newSecret } from './security';
import { dataPaths } from '../core/paths';
import { writeFileAtomic } from '../core/util/fs';

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

declare const __SKILLHANGAR_VERSION__: string;
const VERSION = typeof __SKILLHANGAR_VERSION__ === 'string' ? __SKILLHANGAR_VERSION__ : 'dev';
const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

export function launchUrl(info: Pick<ServerInfo, 'port' | 'token'>): string {
  return `http://127.0.0.1:${info.port}/#token=${info.token}`;
}

/** The running server, if one is alive. Its file is 0600, so only this user can read the token. */
export async function runningServer(): Promise<ServerInfo | null> {
  try {
    const info = JSON.parse(await readFile(dataPaths.server(), 'utf8')) as ServerInfo;
    process.kill(info.pid, 0);
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { host: `127.0.0.1:${info.port}` }, signal: AbortSignal.timeout(1500) }).catch(() => null);
    // A 401 proves our server is listening there (health is behind the session like every API route).
    return response && (response.status === 401 || response.ok) ? info : null;
  } catch {
    return null;
  }
}

export async function startServer(options: { port?: number; dev?: boolean } = {}): Promise<{ info: ServerInfo; close: () => Promise<void> }> {
  const hangar = new Hangar();
  const token = newSecret();
  const session = { cookieName: '', cookieValue: newSecret(), csrf: newSecret() };
  const uiDir = fileURLToPath(new URL('./ui', import.meta.url));
  const devOrigins = options.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [];
  const security = { port: 0, launchToken: token, devOrigins };

  let lastActivity = Date.now();
  const app = createApp(hangar, security, session, existsSync(uiDir) ? uiDir : null);

  const server = await new Promise<ReturnType<typeof serve>>((resolveServer, reject) => {
    const s = serve(
      {
        fetch: (request, env) => {
          lastActivity = Date.now();
          return app.fetch(request, env);
        },
        hostname: '127.0.0.1',
        port: options.port ?? 0,
      },
      () => resolveServer(s),
    );
    s.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  security.port = port;
  session.cookieName = `skillhangar_${port}`;

  const info: ServerInfo = { pid: process.pid, port, token, startedAt: new Date().toISOString(), version: VERSION };
  await writeFileAtomic(dataPaths.server(), JSON.stringify(info), 0o600);

  // Warm the inventory so the first page load is instant, then housekeeping in the background.
  void hangar.rescan().catch((error) => console.error('[skillhangar] scan failed:', error));
  void hangar.housekeeping();

  const close = async () => {
    clearInterval(idleTimer);
    hangar.stopWatching();
    await new Promise<void>((r) => server.close(() => r()));
    const current = await readFile(dataPaths.server(), 'utf8').catch(() => '');
    if (current.includes(`"pid":${process.pid}`)) await rm(dataPaths.server(), { force: true });
  };

  // Shut down after 30 idle minutes, but never while a tab holds the event stream open or a job runs.
  const idleTimer = setInterval(() => {
    const busy = hangar.events.size > 0 || hangar.jobs.list().some((j) => j.state === 'running' || j.state === 'queued');
    if (busy) lastActivity = Date.now();
    else if (Date.now() - lastActivity > IDLE_SHUTDOWN_MS) void close().then(() => process.exit(0));
  }, 60_000);
  idleTimer.unref();

  return { info, close };
}
