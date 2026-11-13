import { request } from 'node:http';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRET, makeFakeHome } from './helpers';

// The fake home must be in place before any module reads paths, and `claude` must not be reachable,
// so nothing touches the real ~/.claude while tests run.
const fixture = await makeFakeHome();
process.env.SKILLHANGAR_TEST_HOME = fixture.home;
process.env.SKILLHANGAR_HOME = fixture.data;
process.env.SKILLHANGAR_MANAGED_DIR = join(fixture.home, 'managed');
process.env.PATH = '/usr/bin:/bin';
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.XDG_STATE_HOME;

const { buildInventory } = await import('../src/core/inventory');
const { AuditCache } = await import('../src/core/audit/cache');
const { startServer } = await import('../src/server/serve');
const { Quarantine } = await import('../src/core/ops/quarantine');
const { installSkill, removeSkill, writeOverride } = await import('../src/core/ops/skills');
const { vault } = await import('../src/core/ops/vault');
const { editSettingsFile } = await import('../src/core/ops/settings-file');
const { registry } = await import('../src/core/store');

describe('discovery', async () => {
  const { inventory } = await buildInventory(new AuditCache());

  it('finds both profiles and lists the shared skills folder once', () => {
    expect(inventory.profiles.map((p) => p.id).sort()).toEqual(['claude-work', 'default']);
    const personal = inventory.skills.filter((s) => s.scope === 'personal');
    expect(personal.map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'risky']);
    expect(personal.find((s) => s.name === 'alpha')!.profileIds.sort()).toEqual(['claude-work', 'default']);
  });

  it('reads provenance and install date from the skills CLI lock', () => {
    const beta = inventory.skills.find((s) => s.name === 'beta')!;
    expect(beta.provenance?.kind).toBe('vercel-lock');
    expect(beta.provenance?.github).toEqual({ owner: 'acme-labs', repo: 'table-skills' });
    expect(beta.installedAt).toBe('2026-05-20T09:14:19.519Z');
    expect(beta.isSymlink).toBe(true);
  });

  it('applies skillOverrides and marks a project copy shadowed by the personal skill', () => {
    const alphas = inventory.skills.filter((s) => s.name === 'alpha');
    expect(alphas.find((s) => s.scope === 'personal')!.override).toBe('name-only');
    expect(alphas.find((s) => s.scope === 'project')!.shadowedBy).toBe(alphas.find((s) => s.scope === 'personal')!.id);
  });

  it('describes MCP servers without ever exposing a value', () => {
    const gh = inventory.mcp.find((m) => m.name === 'gh')!;
    expect(gh.env.find((e) => e.key === 'GITHUB_TOKEN')).toEqual({ key: 'GITHUB_TOKEN', set: true, plaintextSecret: true });
    expect(gh.env.find((e) => e.key === 'LOG_FILE')?.plaintextSecret).toBe(false);
    expect(gh.package).toMatchObject({ ecosystem: 'npm', name: '@modelcontextprotocol/server-github', pinned: false });
    expect(inventory.mcp.find((m) => m.name === 'db')).toMatchObject({ scope: 'local', package: { ecosystem: 'pypi', version: '0.3.1', pinned: true } });
    expect(JSON.stringify(inventory)).not.toContain(FAKE_SECRET);
  });
});

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('server hardening', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port = 0;
  let cookie = '';
  let csrf = '';
  const origin = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    server = await startServer();
    port = server.info.port;
  });
  afterAll(async () => server.close());

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    expect((await call(port, '/api/inventory', { headers: { host: `attacker.example:${port}` } })).status).toBe(403);
  });

  it('refuses API calls without a session', async () => {
    expect((await call(port, '/api/inventory')).status).toBe(401);
  });

  it('refuses a wrong launch token and a cross-origin session request', async () => {
    expect((await call(port, '/api/session', { method: 'POST', headers: { origin: origin(), 'x-skillhangar-token': 'wrong' } })).status).toBe(401);
    expect((await call(port, '/api/session', { method: 'POST', headers: { origin: 'https://attacker.example', 'x-skillhangar-token': server.info.token } })).status).toBe(403);
  });

  it('issues an HttpOnly SameSite=Strict cookie for the right token', async () => {
    const res = await call(port, '/api/session', { method: 'POST', headers: { origin: origin(), 'x-skillhangar-token': server.info.token } });
    expect(res.status).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    cookie = setCookie.split(';')[0]!;
    csrf = (JSON.parse(res.body) as { csrf: string }).csrf;
  });

  it('serves the inventory to the session and never sends CORS headers', async () => {
    const res = await call(port, '/api/inventory', { headers: { cookie, origin: 'https://attacker.example' } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.headers).some((h) => h.startsWith('access-control'))).toBe(false);
    expect(res.body).not.toContain(FAKE_SECRET);
  });

  it('requires the CSRF header and a same-origin Origin for changes', async () => {
    const body = JSON.stringify({ theme: 'dark' });
    const json = { 'content-type': 'application/json' };
    expect((await call(port, '/api/settings', { method: 'PUT', body, headers: { ...json, cookie, origin: origin() } })).status).toBe(403);
    expect((await call(port, '/api/settings', { method: 'PUT', body, headers: { ...json, cookie, origin: 'https://attacker.example', 'x-skillhangar-csrf': csrf } })).status).toBe(403);
    expect((await call(port, '/api/settings', { method: 'PUT', body, headers: { ...json, cookie, origin: origin(), 'x-skillhangar-csrf': csrf } })).status).toBe(200);
  });

  it('refuses to read a file outside a skill folder', async () => {
    const inv = JSON.parse((await call(port, '/api/inventory', { headers: { cookie } })).body) as { skills: { id: string; name: string }[] };
    const id = inv.skills.find((s) => s.name === 'alpha')!.id;
    const res = await call(port, `/api/skills/${id}/file?path=${encodeURIComponent('../../../.claude.json')}`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain(FAKE_SECRET);
  });

  it('sets a strict Content-Security-Policy', async () => {
    const res = await call(port, '/api/health', { headers: { cookie } });
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
  });
});

describe('operations change the disk and can be undone', () => {
  it('installs from quarantine, removes to the trash and restores', async () => {
    const quarantine = new Quarantine();
    const item = await quarantine.fetch({ kind: 'local', path: join(import.meta.dirname, '..', 'fixtures', 'corpus', 'ok-script') });
    expect(item.skills).toHaveLength(1);
    const { inventory } = await buildInventory(new AuditCache());
    const result = await installSkill({ item, relPath: '', dest: { kind: 'project', path: fixture.project }, mode: 'copy', acknowledgeRisk: false, profiles: inventory.profiles });
    expect(result.path).toBe(join(fixture.project, '.claude', 'skills', 'ok-script'));
    expect(await readFile(join(result.path, 'scripts', 'count.py'), 'utf8')).toContain('split');
    const { realpath } = await import('node:fs/promises');
    expect((await registry.get()).installs[await realpath(result.path)]?.provenance.kind).toBe('skillhangar');

    const after = await buildInventory(new AuditCache());
    const real = await realpath(result.path);
    const installed = after.inventory.skills.find((s) => s.realPath === real)!;
    expect(installed.installedAtSource).toBe('skillhangar');
    const trashed = await removeSkill(installed);
    expect(await lstat(result.path).catch(() => null)).toBeNull();
    await vault.restoreTrash(trashed.id);
    expect((await lstat(result.path)).isDirectory()).toBe(true);
    await quarantine.discard(item.id);
  });

  it('refuses a dangerous skill unless the risk is acknowledged', async () => {
    const quarantine = new Quarantine();
    const item = await quarantine.fetch({ kind: 'local', path: join(import.meta.dirname, '..', 'fixtures', 'corpus', 'mal-destructive') });
    const { inventory } = await buildInventory(new AuditCache());
    await expect(installSkill({ item, relPath: '', dest: { kind: 'project', path: fixture.project }, mode: 'copy', acknowledgeRisk: false, profiles: inventory.profiles })).rejects.toMatchObject({ code: 'RISK_NOT_ACKNOWLEDGED' });
    await quarantine.discard(item.id);
  });

  it('snapshots and restores a skill byte for byte', async () => {
    const dir = join(fixture.home, '.claude', 'skills', 'alpha');
    const original = await readFile(join(dir, 'SKILL.md'), 'utf8');
    const snap = await vault.snapshot(dir, 'alpha', 'test', 'hash');
    await writeFile(join(dir, 'SKILL.md'), 'changed');
    await vault.restoreSnapshot(snap.id);
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(original);
  });

  it('writes and reverts skillOverrides, keeping other settings', async () => {
    const path = join(fixture.home, '.claude', 'settings.json');
    await writeFile(path, JSON.stringify({ model: 'opus', skillOverrides: { alpha: 'name-only' } }));
    const change = await writeOverride(path, 'risky', 'off');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'opus', skillOverrides: { alpha: 'name-only', risky: 'off' } });
    await writeOverride(path, 'risky', change.previous);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'opus', skillOverrides: { alpha: 'name-only' } });
  });

  it('never overwrites a settings file it cannot parse', async () => {
    const path = join(fixture.home, '.claude', 'broken.json');
    await writeFile(path, '{ "model": "opus", ');
    await expect(editSettingsFile(path, () => undefined)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, 'utf8')).toBe('{ "model": "opus", ');
  });
});

describe('manifest apply plan', () => {
  it('skips what is installed, pins commits, and turns MCP servers into commands without values', async () => {
    const { planApply } = await import('../src/core/ops/apply');
    const { buildManifest } = await import('../src/core/ops/manifest');
    const { inventory } = await buildInventory(new AuditCache());
    const manifest = buildManifest(inventory);
    expect(JSON.stringify(manifest)).not.toContain(FAKE_SECRET);
    manifest.skills.push({ name: 'newcomer', scope: 'personal', source: 'acme-labs/table-skills', skillPath: 'skills/newcomer/SKILL.md', commit: 'b'.repeat(40) });
    manifest.mcpServers.push({ name: 'fresh', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'fresh-mcp@1.0.0'], env: ['FRESH_TOKEN'] });
    const steps = planApply(manifest, inventory, { profileId: 'default' });
    expect(steps.find((s) => s.name === 'beta')).toMatchObject({ kind: 'skip-skill', reason: 'already installed' });
    expect(steps.find((s) => s.name === 'newcomer')).toMatchObject({ kind: 'install-skill', ref: 'b'.repeat(40), destination: { kind: 'profile', profileId: 'default' } });
    expect(steps.find((s) => s.name === 'gh')).toMatchObject({ kind: 'skip-mcp' });
    const fresh = steps.find((s) => s.name === 'fresh');
    expect(fresh).toMatchObject({ kind: 'add-mcp', needs: ['FRESH_TOKEN'] });
    expect(fresh && 'command' in fresh ? fresh.command : '').toContain('"FRESH_TOKEN":"${FRESH_TOKEN}"');
  });
});
