import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export interface SecurityConfig {
  port: number;
  /** Per-launch secret placed in the URL fragment; exchanged once for a cookie. */
  launchToken: string;
  /** Extra origins allowed in development (the Vite dev server). */
  devOrigins: string[];
}

export interface Session {
  cookieName: string;
  cookieValue: string;
  csrf: string;
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Defences for a local server that can run commands, after three 2025 advisories in this tool class
 * (MCP Inspector CVE-2025-49596, Claude Code CVE-2025-52882, MCP TypeScript SDK CVE-2025-66414):
 * - the Host header must name this loopback port, which defeats DNS rebinding;
 * - every API call needs the session cookie, which only the launch token can obtain;
 * - state-changing calls also need a same-origin Origin header and the CSRF header;
 * - no CORS headers are ever sent, and the page runs under a strict Content-Security-Policy.
 */
export function securityMiddleware(config: SecurityConfig, session: Session): MiddlewareHandler {
  // The port is known only after the socket binds, so the allow-lists are built on first use.
  let builtFor = -1;
  let hosts = new Set<string>();
  let origins = new Set<string>();

  return async (c, next) => {
    if (builtFor !== config.port) {
      builtFor = config.port;
      hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, ...config.devOrigins.map((o) => new URL(o).host)]);
      origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...config.devOrigins]);
    }
    const host = c.req.header('host') ?? '';
    if (!hosts.has(host)) return c.text('Forbidden host', 403);

    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const path = c.req.path;
    if (!path.startsWith('/api/')) return next();

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const origin = c.req.header('origin');
    if (mutating && (!origin || !origins.has(origin))) return c.json({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } }, 403);
    if (c.req.method === 'OPTIONS') return c.body(null, 403);

    if (path === '/api/session' && c.req.method === 'POST') {
      const token = c.req.header('x-skillhangar-token') ?? '';
      if (!safeEqual(token, config.launchToken)) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Open Skillhangar with the link it printed.' } }, 401);
      setCookie(c, session.cookieName, session.cookieValue, { httpOnly: true, sameSite: 'Strict', path: '/', secure: false });
      return c.json({ csrf: session.csrf });
    }

    const cookie = getCookie(c, session.cookieName) ?? '';
    if (!safeEqual(cookie, session.cookieValue)) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired. Run skillhangar again to get a new link.' } }, 401);
    if (mutating && !safeEqual(c.req.header('x-skillhangar-csrf') ?? '', session.csrf)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Missing CSRF header.' } }, 403);
    }
    return next();
  };
}
