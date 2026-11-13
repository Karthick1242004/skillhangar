import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Hangar } from './hangar';
import { securityMiddleware, type SecurityConfig, type Session } from './security';
import { OpError } from '../core/ops/errors';
import { addMcpServer, pluginAction, probeMcp, removeMcpServer } from '../core/ops/claude-cli';
import { buildManifest } from '../core/ops/manifest';
import { resolveSource, SourceError, toPublicItem } from '../core/ops/quarantine';
import { applyUpdate, installSkill, linkOrigin, prepareUpdate, removeSkill, setOverride, writeOverride } from '../core/ops/skills';
import { traceOrigin } from '../core/ops/trace';
import { setUsageHook, usageReport } from '../core/ops/usage';
import { vault } from '../core/ops/vault';
import { readActivity, registry, settings } from '../core/store';
import { isInside, readTextCapped } from '../core/util/fs';
import { which } from '../core/util/proc';
import { SCANNERS } from '../core/audit/scanners';
import { MODEL_CHOICES, type McpServerRecord, type ScannerInfo, type SkillDetail, type SkillFileEntry } from '../shared/types';
import { shortHash } from '../core/util/ids';

const MODEL = z.string().regex(/^[\w.[\]-]{2,64}$/, 'Model must be an alias such as sonnet or a model id.');
const Destination = z.discriminatedUnion('kind', [z.object({ kind: z.literal('profile'), profileId: z.string().min(1) }), z.object({ kind: z.literal('project'), path: z.string().min(1) })]);

const schemas = {
  audit: z.object({ model: MODEL, budgetUsd: z.number().min(0.01).max(20), maxTurns: z.number().int().min(2).max(100) }),
  override: z.object({ value: z.enum(['on', 'name-only', 'user-invocable-only', 'off']) }),
  fetch: z.object({ source: z.string().min(1).max(500) }),
  install: z.object({ quarantineId: z.string(), relPath: z.string(), destination: Destination, mode: z.enum(['copy', 'symlink']), acknowledgeRisk: z.boolean().default(false) }),
  copy: z.object({ destination: Destination, mode: z.enum(['copy', 'symlink']) }),
  applyUpdate: z.object({ acknowledgeRisk: z.boolean().default(false) }),
  linkOrigin: z.object({ owner: z.string().regex(/^[\w.-]+$/), repo: z.string().regex(/^[\w.-]+$/), skillPath: z.string().max(300) }),
  mcpAdd: z.object({
    profileId: z.string(),
    name: z.string(),
    scope: z.enum(['user', 'project', 'local']),
    projectPath: z.string().optional(),
    config: z.record(z.string(), z.unknown()),
  }),
  probe: z.object({ profileId: z.string(), cwd: z.string().optional() }),
  pluginAction: z.object({ action: z.enum(['enable', 'disable', 'update', 'uninstall']), profileId: z.string() }),
  settings: z.object({
    network: z.object({ enabled: z.boolean() }).optional(),
    audit: z.object({ defaultModel: MODEL, budgetUsd: z.number().min(0.01).max(20), maxTurns: z.number().int().min(2).max(100) }).partial().optional(),
    projects: z.array(z.string()).max(200).optional(),
    theme: z.enum(['system', 'light', 'dark']).optional(),
  }),
  usageHook: z.object({ profileId: z.string(), enabled: z.boolean() }),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new OpError('INVALID', 'The request body is not JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new OpError('INVALID', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return parsed.data;
}


/** A project chosen as an install target becomes a known project, so its skills show after the rescan. */
async function rememberProject(destination: { kind: 'profile' | 'project'; path?: string }, known: string[]): Promise<void> {
  if (destination.kind !== 'project' || !destination.path) return;
  const path = resolve(destination.path);
  if (known.includes(path)) return;
  await settings.update((draft) => {
    if (!draft.projects.includes(path)) draft.projects.push(path);
  });
}

export function createApp(hangar: Hangar, security: SecurityConfig, session: Session, uiDir: string | null): Hono {
  const app = new Hono();
  app.use('*', securityMiddleware(security, session));

  app.onError((error, c) => {
    if (error instanceof OpError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    if (error instanceof SourceError) return c.json({ error: { code: 'INVALID', message: error.message } }, 400);
    console.error('[skillhangar]', error);
    return c.json({ error: { code: 'INTERNAL', message: (error as Error).message } }, 500);
  });

  const api = new Hono();

  api.get('/csrf', (c) => c.json({ csrf: session.csrf }));
  api.get('/health', (c) => c.json({ ok: true, version: typeof __SKILLHANGAR_VERSION__ === 'string' ? __SKILLHANGAR_VERSION__ : 'dev' }));
  api.get('/models', async (c) => c.json({ models: MODEL_CHOICES, defaults: (await settings.get()).audit }));

  // Inventory
  api.get('/inventory', async (c) => {
    if (c.req.query('refresh')) await hangar.rescan();
    return c.json(await hangar.inventoryView());
  });

  api.get('/skills/:id', async (c) => {
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    const scanned = snap.scanned.get(skill.id);
    const isFile = skill.scope === 'legacy-command';
    const [md, staticAudit, claudeAudits, scanners, snapshots, usage] = await Promise.all([
      readTextCapped(isFile ? skill.realPath : join(skill.realPath, 'SKILL.md'), 512 * 1024),
      hangar.staticAudit(skill, snap),
      hangar.audits.listClaude(skill.contentHash),
      hangar.audits.listScanners(skill.contentHash),
      vault.listSnapshots(skill.realPath),
      usageReport(snap.inventory.profiles, false).then((r) => r.skills.find((u) => u.name.toLowerCase() === skill.name.toLowerCase()) ?? null),
    ]);
    const files: SkillFileEntry[] = [];
    for (const f of scanned?.tree?.files ?? []) files.push({ path: f.rel, size: f.size, kind: f.kind === 'symlink' ? 'symlink' : f.kind });
    for (const dir of scanned?.tree?.vendoredDirs ?? []) files.push({ path: `${dir}/`, size: 0, kind: 'vendored' });
    const detail: SkillDetail = { skill, skillMd: md?.text ?? '', files: files.slice(0, 2000), staticAudit, claudeAudits, scanners, snapshots, usage };
    return c.json(detail);
  });

  api.get('/skills/:id/file', async (c) => {
    const { skill } = await hangar.skill(c.req.param('id'));
    const rel = c.req.query('path') ?? '';
    const target = resolve(skill.realPath, rel);
    if (!rel || !isInside(skill.realPath, target)) throw new OpError('INVALID', 'That path is outside the skill folder.');
    const file = await readTextCapped(target, 512 * 1024);
    if (!file) throw new OpError('NOT_FOUND', 'File not found.');
    if (file.text.includes('\u0000')) throw new OpError('NOT_SUPPORTED', 'Binary file.');
    return c.json({ path: rel, text: file.text, truncated: file.truncated });
  });

  api.post('/skills/:id/audit', async (c) => {
    const options = await body(c, schemas.audit);
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    return c.json({ job: hangar.startClaudeAudit(skill, snap, options) });
  });

  api.get('/scanners', async (c) => {
    const uvx = !!(await which('uvx'));
    const list: ScannerInfo[] = SCANNERS.map((s) => ({ id: s.id, label: s.label, homepage: s.homepage, available: uvx }));
    return c.json({ scanners: list });
  });

  api.post('/skills/:id/scan', async (c) => {
    const { scanner } = await body(c, z.object({ scanner: z.enum(['cisco', 'skillspector']) }));
    if (!(await settings.get()).network.enabled) throw new OpError('POLICY', 'The first run downloads the scanner. Turn on network lookups in Settings.');
    if (!(await which('uvx'))) throw new OpError('NOT_SUPPORTED', 'External scanners run through uvx. Install uv from https://docs.astral.sh/uv/ first.');
    const { skill } = await hangar.skill(c.req.param('id'));
    return c.json({ job: hangar.startScanner(skill, scanner) });
  });

  api.post('/skills/:id/review', async (c) => {
    const { skill } = await hangar.skill(c.req.param('id'));
    await registry.update((draft) => {
      draft.reviews[skill.realPath] = { reviewedAt: new Date().toISOString(), contentHash: skill.contentHash };
    });
    skill.review = { reviewedAt: new Date().toISOString(), contentHash: skill.contentHash, changedSince: false };
    await hangar.log({ action: 'review', target: skill.name, detail: `content ${skill.contentHash.slice(0, 12)}` });
    return c.json({ ok: true });
  });

  api.post('/skills/:id/override', async (c) => {
    const { value } = await body(c, schemas.override);
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    const change = await setOverride(skill, value, snap.inventory.profiles);
    await hangar.log({
      action: 'override',
      target: skill.name,
      detail: `${change.previous ?? 'on'} → ${change.next} in ${change.path}`,
      undo: { kind: 'override-restore', ref: JSON.stringify({ path: change.path, name: change.name, previous: change.previous ?? null }) },
    });
    await hangar.rescan();
    return c.json({ ok: true });
  });

  api.post('/skills/:id/remove', async (c) => {
    const { skill } = await hangar.skill(c.req.param('id'));
    const item = await removeSkill(skill);
    await hangar.log({ action: 'remove', target: skill.name, detail: `moved ${skill.path} to the trash`, undo: { kind: 'trash-restore', ref: item.id } });
    await hangar.rescan();
    return c.json({ ok: true, trashId: item.id });
  });

  api.post('/skills/:id/update/check', async (c) => {
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    const prepared = await prepareUpdate(skill, snap.scanned.get(skill.id), hangar.quarantine, hangar.audits, hangar.hasher);
    hangar.previews.set(skill.id, prepared);
    const { sourceDir: _s, treeSha: _t, commit: _c, ...preview } = prepared;
    return c.json(preview);
  });

  api.post('/skills/:id/update/apply', async (c) => {
    const { acknowledgeRisk } = await body(c, schemas.applyUpdate);
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    const prepared = hangar.previews.get(skill.id);
    if (!prepared) throw new OpError('INVALID', 'Check for the update again before applying it.');
    if (prepared.fromHash !== skill.contentHash) throw new OpError('CONFLICT', 'The skill changed on disk since the preview. Check for the update again.');
    const result = await applyUpdate(skill, prepared, acknowledgeRisk, snap.inventory.profiles);
    hangar.previews.delete(skill.id);
    await hangar.quarantine.discard(prepared.quarantineId);
    await hangar.log({ action: 'update', target: skill.name, detail: result.warning ?? `${prepared.diff.length} file(s) changed via ${prepared.method}`, undo: { kind: 'snapshot-restore', ref: result.snapshotId } });
    await hangar.rescan();
    return c.json({ ok: true, warning: result.warning ?? null });
  });

  api.post('/skills/:id/trace', async (c) => {
    const { skill } = await hangar.skill(c.req.param('id'));
    if (!(await settings.get()).network.enabled) throw new OpError('POLICY', 'Turn on network lookups in Settings to search for an origin.');
    return c.json({ candidates: await traceOrigin(skill) });
  });

  api.post('/skills/:id/link-origin', async (c) => {
    const origin = await body(c, schemas.linkOrigin);
    const { skill } = await hangar.skill(c.req.param('id'));
    const provenance = await linkOrigin(skill, origin);
    await hangar.log({ action: 'link-origin', target: skill.name, detail: provenance.source });
    await hangar.rescan();
    return c.json({ provenance });
  });

  api.post('/skills/:id/copy', async (c) => {
    const { destination, mode } = await body(c, schemas.copy);
    const { skill, snap } = await hangar.skill(c.req.param('id'));
    const item = await hangar.quarantine.fetch({ kind: 'local', path: skill.realPath });
    try {
      const rel = item.skills.find((s) => s.relPath === '')?.relPath ?? item.skills[0]?.relPath ?? '';
      const result = await installSkill({ item, relPath: rel, dest: destination, mode, acknowledgeRisk: true, profiles: snap.inventory.profiles });
      await rememberProject(destination, snap.inventory.projects);
      await hangar.log({ action: 'copy', target: skill.name, detail: `to ${result.path}`, undo: { kind: 'remove-install', ref: result.path } });
    } finally {
      await hangar.quarantine.discard(item.id);
    }
    await hangar.rescan();
    return c.json({ ok: true });
  });

  // Install
  api.post('/install/fetch', async (c) => {
    const { source } = await body(c, schemas.fetch);
    const spec = resolveSource(source);
    if (spec.kind === 'github' && !(await settings.get()).network.enabled) throw new OpError('POLICY', 'Turn on network lookups in Settings to download from GitHub.');
    return c.json(toPublicItem(await hangar.quarantine.fetch(spec)));
  });

  api.post('/install/apply', async (c) => {
    const input = await body(c, schemas.install);
    const item = await hangar.quarantine.get(input.quarantineId);
    if (!item) throw new OpError('NOT_FOUND', 'That download expired. Fetch the source again.');
    const { inventory } = await hangar.current();
    const result = await installSkill({ item, relPath: input.relPath, dest: input.destination, mode: input.mode, acknowledgeRisk: input.acknowledgeRisk, profiles: inventory.profiles });
    await rememberProject(input.destination, inventory.projects);
    await hangar.log({ action: 'install', target: result.name, detail: `${result.provenance.source} to ${result.path}`, undo: { kind: 'remove-install', ref: result.path } });
    await hangar.rescan();
    return c.json({ ok: true, path: result.path });
  });

  api.post('/install/:qid/audit', async (c) => {
    const input = await body(c, schemas.audit.extend({ relPath: z.string() }));
    const item = await hangar.quarantine.get(c.req.param('qid'));
    const skill = item?.skills.find((s) => s.relPath === input.relPath);
    if (!item || !skill) throw new OpError('NOT_FOUND', 'That download expired. Fetch the source again.');
    return c.json({ job: hangar.startQuarantineAudit(skill, input) });
  });

  api.get('/audits/hash/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new OpError('INVALID', 'Invalid content hash.');
    return c.json({ audits: await hangar.audits.listClaude(hash) });
  });

  api.delete('/install/:qid', async (c) => {
    await hangar.quarantine.discard(c.req.param('qid'));
    return c.json({ ok: true });
  });

  // MCP
  api.post('/mcp/probe', async (c) => {
    const { profileId, cwd } = await body(c, schemas.probe);
    const { inventory } = await hangar.current();
    const profile = inventory.profiles.find((p) => p.id === profileId);
    if (!profile) throw new OpError('NOT_FOUND', 'Unknown profile.');
    if (cwd && !inventory.projects.includes(cwd)) throw new OpError('INVALID', 'Probe a known project folder.');
    // Without a project, the probe runs in the home folder, whose local-scope servers it then also reports.
    const where = cwd ?? homedir();
    const { job, done } = hangar.jobs.start('mcp-probe', `Checking MCP servers for ${profile.label}`, () => probeMcp(profile, where));
    done
      .then((result) => {
        const map = new Map<string, { state: (typeof result.statuses)[string]; checkedAt: string }>();
        for (const server of inventory.mcp) {
          if (!server.profileIds.includes(profileId)) continue;
          if ((server.scope === 'local' || server.scope === 'project') && server.projectPath !== where) continue;
          const state = result.statuses[server.name];
          if (state) map.set(server.id, { state, checkedAt: result.checkedAt });
        }
        // Servers the probe reports that no config file holds are claude.ai connectors on the account.
        const configured = new Set(inventory.mcp.map((m) => m.name));
        const connectors: McpServerRecord[] = Object.entries(result.statuses)
          .filter(([name]) => !configured.has(name) && name.startsWith('claude.ai '))
          .map(([name, state]) => {
            const target = result.targets[name] ?? '';
            let host: string | undefined;
            try {
              host = new URL(target).host;
            } catch {
              host = undefined;
            }
            return { id: shortHash(`connector|${name}`), name, profileIds: [profileId], scope: 'connector', transport: 'http', args: [], url: target || undefined, host, env: [], headers: [], auth: { state, checkedAt: result.checkedAt, source: 'probe' }, health: [] };
          });
        hangar.setConnectors(profileId, connectors);
        hangar.setProbeResults(map);
      })
      .catch(() => undefined);
    return c.json({ job });
  });

  api.post('/mcp', async (c) => {
    const input = await body(c, schemas.mcpAdd);
    const { inventory } = await hangar.current();
    const profile = inventory.profiles.find((p) => p.id === input.profileId);
    if (!profile) throw new OpError('NOT_FOUND', 'Unknown profile.');
    const denied = inventory.policy.flatMap((p) => p.deniedMcpServers);
    if (denied.includes(input.name)) throw new OpError('POLICY', `Your organization's policy blocks the server "${input.name}".`);
    await addMcpServer(profile, input.name, input.config, input.scope, input.projectPath);
    await hangar.log({ action: 'mcp-add', target: input.name, detail: `${input.scope} scope in ${profile.label}` });
    await hangar.rescan();
    return c.json({ ok: true });
  });

  api.delete('/mcp/:id', async (c) => {
    const { inventory } = await hangar.current();
    const server = inventory.mcp.find((m) => m.id === c.req.param('id'));
    if (!server) throw new OpError('NOT_FOUND', 'That server is no longer configured.');
    const profile = inventory.profiles.find((p) => server.profileIds.includes(p.id) && (p.isActive || server.profileIds.length === 1)) ?? inventory.profiles.find((p) => server.profileIds.includes(p.id));
    if (!profile) throw new OpError('NOT_FOUND', 'No profile holds this server.');
    await removeMcpServer(profile, server.name, server.scope, server.projectPath);
    await hangar.log({ action: 'mcp-remove', target: server.name, detail: `${server.scope} scope in ${profile.label}` });
    await hangar.rescan();
    return c.json({ ok: true });
  });

  // Plugins
  api.post('/plugins/:id/action', async (c) => {
    const { action, profileId } = await body(c, schemas.pluginAction);
    const { inventory } = await hangar.current();
    const plugin = inventory.plugins.find((p) => p.id === c.req.param('id') && p.profileIds.includes(profileId));
    const profile = inventory.profiles.find((p) => p.id === profileId);
    if (!plugin || !profile) throw new OpError('NOT_FOUND', 'Plugin not found in that profile.');
    await pluginAction(profile, plugin, action);
    await hangar.log({ action: `plugin-${action}`, target: plugin.id, detail: profile.label });
    await hangar.rescan();
    return c.json({ ok: true });
  });

  // Enrichment and jobs
  api.get('/enrichment', async (c) => c.json(await hangar.enrichment.get((await settings.get()).network.enabled)));
  api.post('/enrichment/refresh', async (c) => {
    if (!(await settings.get()).network.enabled) throw new OpError('POLICY', 'Network lookups are off. Turn them on in Settings.');
    return c.json({ job: hangar.startEnrichment() });
  });
  api.post('/trending/build', async (c) => {
    if (!(await settings.get()).network.enabled) throw new OpError('POLICY', 'Network lookups are off. Turn them on in Settings.');
    return c.json({ job: hangar.startTrendingIndex() });
  });
  api.get('/jobs', (c) => c.json({ jobs: hangar.jobs.list() }));
  api.post('/jobs/:id/cancel', (c) => c.json({ ok: hangar.jobs.cancel(c.req.param('id')) }));
  api.get('/audits', async (c) => c.json({ audits: await hangar.audits.listAllClaude(), jobs: hangar.jobs.list().filter((j) => j.kind === 'claude-audit') }));

  // Activity, trash, snapshots
  api.get('/activity', async (c) => c.json({ entries: await readActivity() }));
  api.post('/activity/:id/undo', async (c) => {
    const entries = await readActivity(2000);
    const entry = entries.find((e) => e.id === c.req.param('id'));
    if (!entry?.undo || entry.undone) throw new OpError('INVALID', 'Nothing to undo for this entry.');
    if (entry.undo.kind === 'trash-restore') await vault.restoreTrash(entry.undo.ref);
    else if (entry.undo.kind === 'snapshot-restore') await vault.restoreSnapshot(entry.undo.ref);
    else if (entry.undo.kind === 'override-restore') {
      const { path, name, previous } = JSON.parse(entry.undo.ref) as { path: string; name: string; previous: 'on' | 'name-only' | 'user-invocable-only' | 'off' | null };
      await writeOverride(path, name, previous ?? undefined);
    } else if (entry.undo.kind === 'remove-install') {
      const { inventory } = await hangar.current();
      const installed = inventory.skills.find((s) => s.path === entry.undo!.ref);
      if (!installed) throw new OpError('NOT_FOUND', 'The installed skill is no longer there.');
      await removeSkill(installed);
    }
    await hangar.log({ action: 'undo', target: entry.id, detail: `${entry.action} ${entry.target}` });
    await hangar.rescan();
    return c.json({ ok: true });
  });
  api.get('/trash', async (c) => c.json({ items: await vault.listTrash() }));
  api.post('/trash/:id/restore', async (c) => {
    const item = await vault.restoreTrash(c.req.param('id'));
    await hangar.log({ action: 'restore', target: item.name, detail: item.originalPath });
    await hangar.rescan();
    return c.json({ ok: true });
  });
  api.post('/snapshots/:id/restore', async (c) => {
    const { snapshot, replaced } = await vault.restoreSnapshot(c.req.param('id'));
    await hangar.log({ action: 'rollback', target: snapshot.name, detail: `to the version from ${snapshot.createdAt}`, undo: replaced ? { kind: 'trash-restore', ref: replaced.id } : undefined });
    await hangar.rescan();
    return c.json({ ok: true });
  });

  // Settings, usage, manifest
  api.get('/settings', async (c) => c.json(await settings.get()));
  api.put('/settings', async (c) => {
    const patch = await body(c, schemas.settings);
    const next = await settings.update((draft) => {
      if (patch.network) draft.network = { enabled: patch.network.enabled, decidedAt: new Date().toISOString() };
      if (patch.audit) draft.audit = { ...draft.audit, ...patch.audit };
      if (patch.projects) draft.projects = [...new Set(patch.projects.map((p) => resolve(p)))];
      if (patch.theme) draft.theme = patch.theme;
    });
    if (patch.projects) void hangar.rescan().catch(() => undefined);
    if (patch.network?.enabled) hangar.startEnrichment();
    return c.json(next);
  });
  api.get('/usage', async (c) => {
    const { inventory } = await hangar.current();
    return c.json(await usageReport(inventory.profiles, c.req.query('transcripts') === '1'));
  });
  api.post('/usage/hook', async (c) => {
    const { profileId, enabled } = await body(c, schemas.usageHook);
    const { inventory } = await hangar.current();
    const profile = inventory.profiles.find((p) => p.id === profileId);
    if (!profile) throw new OpError('NOT_FOUND', 'Unknown profile.');
    await setUsageHook(profile, enabled);
    await hangar.log({ action: enabled ? 'usage-hook-on' : 'usage-hook-off', target: profile.label });
    return c.json({ ok: true });
  });
  api.get('/manifest', async (c) => {
    const { inventory } = await hangar.current();
    c.header('Content-Disposition', 'attachment; filename="skillhangar.json"');
    return c.json(buildManifest(inventory));
  });

  // Server-sent events: one stream per tab, with a heartbeat so idle proxies and sleeping laptops reconnect.
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = hangar.events.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(20_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    }),
  );

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }, 404));

  if (uiDir) mountUi(app, uiDir);
  return app;
}

declare const __SKILLHANGAR_VERSION__: string;

/**
 * Serves the prebuilt UI. Hashed assets are immutable; index.html is never cached so a new version shows at once.
 * Files are read once and kept in memory: the whole UI is a few hundred kilobytes.
 */
function mountUi(app: Hono, uiDir: string): void {
  const cache = new Map<string, Buffer | null>();
  const types: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
  };
  const load = async (rel: string) => {
    if (cache.has(rel)) return cache.get(rel)!;
    const target = resolve(uiDir, rel);
    const data = isInside(uiDir, target) ? await readFile(target).catch(() => null) : null;
    cache.set(rel, data);
    return data;
  };
  app.get('*', async (c) => {
    const path = decodeURIComponent(c.req.path);
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const ext = rel.slice(rel.lastIndexOf('.'));
    const data = (await load(rel)) ?? (types[ext] ? null : await load('index.html'));
    if (!data) return c.text('Not found', 404);
    const isIndex = !types[ext] || rel === 'index.html';
    c.header('Content-Type', isIndex ? types['.html']! : types[ext]!);
    c.header('Cache-Control', isIndex ? 'no-cache' : 'public, max-age=31536000, immutable');
    return c.body(new Uint8Array(data));
  });
}
