import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EventBus, JobManager } from './events';
import { AuditCache } from '../core/audit/cache';
import { runClaudeAudit } from '../core/audit/claude';
import { runScanner, SCANNERS, type ScannerSpec } from '../core/audit/scanners';
import { verdictFromFindings, worseVerdict } from '../core/audit/verdict';
import { runStaticAudit } from '../core/audit/static';
import { EnrichmentService } from '../core/enrich/service';
import { updateTrending } from '../core/enrich/trending';
import { buildInventory, type InventorySnapshot } from '../core/inventory';
import { OpError } from '../core/ops/errors';
import { Quarantine } from '../core/ops/quarantine';
import type { PreparedUpdate } from '../core/ops/skills';
import { vault } from '../core/ops/vault';
import { registry, settings } from '../core/store';
import { TreeHasher, walkTree } from '../core/tree';
import { exists } from '../core/util/fs';
import { newId } from '../core/util/ids';
import { mapLimit } from '../core/util/limit';
import type { ActivityEntry, ClaudeAudit, Inventory, McpAuthState, McpServerRecord, SkillRecord, StaticAudit } from '../shared/types';
import { recordActivity } from '../core/store';

const IGNORED_CHANGE = /(^|[\\/])(node_modules|\.venv|venv|__pycache__|\.git|ms-playwright|site-packages|\.pytest_cache|\.DS_Store)([\\/]|$)/;

/** Holds server state: the current inventory, caches, background jobs and the file watcher. */
export class Hangar {
  readonly events = new EventBus();
  readonly jobs = new JobManager(this.events);
  readonly audits = new AuditCache();
  readonly enrichment = new EnrichmentService();
  readonly quarantine = new Quarantine();
  readonly hasher = new TreeHasher();
  readonly previews = new Map<string, PreparedUpdate>();
  private probe = new Map<string, { state: McpAuthState; checkedAt: string }>();
  /** claude.ai connectors seen by the last probe of each profile; they live in the account, not in config files. */
  private connectors = new Map<string, McpServerRecord[]>();
  private snapshot: InventorySnapshot | null = null;
  private scanning: Promise<InventorySnapshot> | null = null;
  private rescanQueued = false;
  private watchers: FSWatcher[] = [];
  private watchKey = '';
  private watchTimer: NodeJS.Timeout | null = null;
  private configHashes = new Map<string, string>();
  private staticRun: Promise<void> | null = null;
  private failedHashes = new Set<string>();

  /** Current inventory; scans once on first use, then serves the cached copy that the watcher keeps fresh. */
  async current(): Promise<InventorySnapshot> {
    return this.snapshot ?? this.rescan();
  }

  /** Single-flight: concurrent callers share one scan, and a change during a scan queues exactly one more. */
  rescan(): Promise<InventorySnapshot> {
    if (this.scanning) {
      this.rescanQueued = true;
      return this.scanning;
    }
    this.scanning = buildInventory(this.audits)
      .then((snap) => {
        this.snapshot = snap;
        this.events.emit({ type: 'inventory', generatedAt: snap.inventory.generatedAt });
        void this.auditMissing();
        void this.rewatch(snap.inventory);
        return snap;
      })
      .finally(() => {
        this.scanning = null;
        if (this.rescanQueued) {
          this.rescanQueued = false;
          void this.rescan().catch(() => undefined);
        }
      });
    return this.scanning;
  }

  /** The inventory as served: probed MCP statuses override the cached guess from config. */
  async inventoryView(): Promise<Inventory> {
    const { inventory } = await this.current();
    if (!this.probe.size && !this.connectors.size) return inventory;
    const connectors = new Map<string, McpServerRecord>();
    for (const list of this.connectors.values()) {
      for (const c of list) {
        const seen = connectors.get(c.name);
        connectors.set(c.name, seen ? { ...seen, profileIds: [...new Set([...seen.profileIds, ...c.profileIds])] } : c);
      }
    }
    return {
      ...inventory,
      mcp: [
        ...inventory.mcp.map((m) => {
          const probed = this.probe.get(m.id);
          return probed ? { ...m, auth: { state: probed.state, checkedAt: probed.checkedAt, source: 'probe' as const } } : m;
        }),
        ...connectors.values(),
      ],
    };
  }

  setConnectors(profileId: string, list: McpServerRecord[]): void {
    this.connectors.set(profileId, list);
  }

  setProbeResults(results: Map<string, { state: McpAuthState; checkedAt: string }>): void {
    for (const [id, value] of results) this.probe.set(id, value);
    if (this.snapshot) this.events.emit({ type: 'inventory', generatedAt: new Date().toISOString() });
  }

  async skill(id: string): Promise<{ skill: SkillRecord; snap: InventorySnapshot }> {
    const snap = await this.current();
    const skill = snap.inventory.skills.find((s) => s.id === id);
    if (!skill) throw new OpError('NOT_FOUND', 'That skill is no longer installed. Refresh to see the current list.');
    return { skill, snap };
  }

  /** Static audit for one skill, from cache or computed now. */
  async staticAudit(skill: SkillRecord, snap: InventorySnapshot): Promise<StaticAudit> {
    const cached = this.audits.getStatic(skill.contentHash);
    if (cached) return cached;
    const scanned = snap.scanned.get(skill.id);
    const isFile = skill.scope === 'legacy-command';
    const tree = isFile ? null : (scanned?.tree ?? (await walkTree(skill.realPath)));
    const audit = await runStaticAudit(skill.realPath, tree, scanned?.frontmatter ?? {}, skill.contentHash, isFile ? skill.realPath : undefined);
    await this.audits.putStatic(audit);
    return audit;
  }

  /** Fills in static audits for every skill that has none for its current content, then refreshes the summaries in place. */
  private auditMissing(): Promise<void> {
    if (this.staticRun) return this.staticRun;
    this.staticRun = (async () => {
      const snap = this.snapshot;
      if (!snap) return;
      const missing = snap.inventory.skills.filter((s) => s.contentHash && !s.audit && !this.failedHashes.has(s.contentHash));
      if (!missing.length) return;
      const { done } = this.jobs.start('scan', `Auditing ${missing.length} skills`, async ({ progress }) => {
        let count = 0;
        await mapLimit(missing, 4, async (skill) => {
          const audit = await this.staticAudit(skill, snap).catch((error: Error) => {
            this.failedHashes.add(skill.contentHash);
            console.error(`[skillhangar] static audit of ${skill.path} failed: ${error.message}`);
            return null;
          });
          if (audit) skill.audit = { verdict: audit.verdict, counts: audit.counts, contentHash: audit.contentHash, claude: skill.audit?.claude };
          progress(++count, missing.length);
        });
      });
      await done.catch(() => undefined);
      this.events.emit({ type: 'inventory', generatedAt: new Date().toISOString() });
    })().finally(() => {
      this.staticRun = null;
    });
    return this.staticRun;
  }

  startClaudeAudit(skill: SkillRecord, snap: InventorySnapshot, options: { model: string; budgetUsd: number; maxTurns: number }) {
    const running = this.jobs.active('claude-audit', skill.id);
    if (running) return running;
    const { job } = this.jobs.start(
      'claude-audit',
      `Claude audit of ${skill.name} (${options.model})`,
      async ({ signal }) => {
        const staticAudit = await this.staticAudit(skill, snap);
        const { audit } = await runClaudeAudit(
          { name: skill.name, description: skill.description, root: skill.realPath, contentHash: skill.contentHash, singleFile: skill.scope === 'legacy-command' },
          staticAudit,
          { ...options, signal },
        );
        await this.saveClaudeAudit(skill, audit);
        return audit;
      },
      skill.id,
    );
    return job;
  }

  /** Claude audit of a downloaded skill before it is installed; keyed by content hash, so it carries over after install. */
  startQuarantineAudit(skill: { name: string; description: string; dir: string; contentHash: string; audit: StaticAudit }, options: { model: string; budgetUsd: number; maxTurns: number }) {
    const running = this.jobs.active('claude-audit', skill.contentHash);
    if (running) return running;
    return this.jobs.start(
      'claude-audit',
      `Claude audit of ${skill.name} before install (${options.model})`,
      async ({ signal }) => {
        const { audit } = await runClaudeAudit({ name: skill.name, description: skill.description, root: skill.dir, contentHash: skill.contentHash, singleFile: false }, skill.audit, { ...options, signal });
        await this.audits.putClaude(audit);
        await this.log({ action: 'claude-audit', target: skill.name, detail: `${audit.combinedVerdict} by ${audit.model} before install` });
        return audit;
      },
      skill.contentHash,
    ).job;
  }

  private async saveClaudeAudit(skill: SkillRecord, audit: ClaudeAudit): Promise<void> {
    const file = await this.audits.putClaude(audit);
    await registry.update((draft) => {
      draft.latestClaudeAudit[skill.realPath] = { file, contentHash: audit.contentHash, verdict: audit.combinedVerdict, model: audit.model, at: audit.at };
    });
    if (skill.audit) skill.audit.claude = { verdict: audit.combinedVerdict, model: audit.model, at: audit.at, contentHash: audit.contentHash };
    await this.log({ action: 'claude-audit', target: skill.name, detail: `${audit.combinedVerdict} by ${audit.model}${audit.costUsd !== null ? `, $${audit.costUsd.toFixed(4)}` : ''}` });
    this.events.emit({ type: 'inventory', generatedAt: new Date().toISOString() });
  }

  startScanner(skill: SkillRecord, scanner: ScannerSpec['id']) {
    const running = this.jobs.active('scanner', skill.id);
    if (running) return running;
    const spec = SCANNERS.find((s) => s.id === scanner)!;
    return this.jobs.start(
      'scanner',
      `${spec.label} on ${skill.name}`,
      async ({ signal }) => {
        const result = await runScanner(scanner, skill.realPath, skill.scope === 'legacy-command', signal);
        await this.audits.putScanner(skill.contentHash, result);
        if (!result.ok) throw new Error(result.error);
        const verdict = verdictFromFindings(result.findings);
        await registry.update((draft) => {
          draft.latestScanner ??= {};
          draft.latestScanner[skill.realPath] = { ...(draft.latestScanner[skill.realPath] ?? {}), [scanner]: { contentHash: skill.contentHash, verdict, at: result.at } };
        });
        if (skill.audit) {
          const names = [...new Set([...(skill.audit.scanners?.names ?? []), scanner])];
          skill.audit.scanners = { verdict: skill.audit.scanners ? worseVerdict(skill.audit.scanners.verdict, verdict) : verdict, names };
        }
        await this.log({ action: 'scanner', target: skill.name, detail: `${spec.label}: ${verdict}, ${result.findings.length} finding(s)` });
        this.events.emit({ type: 'inventory', generatedAt: new Date().toISOString() });
        return result;
      },
      skill.id,
    ).job;
  }

  startTrendingIndex() {
    const running = this.jobs.active('trending-index');
    if (running) return running;
    return this.jobs.start('trending-index', 'Indexing the GitHub Trending archive', async ({ progress, signal }) => {
      const index = await updateTrending(progress, signal);
      this.enrichment.applyTrending(index);
      this.events.emit({ type: 'enrichment', fetchedAt: new Date().toISOString() });
    }).job;
  }

  startEnrichment() {
    const running = this.jobs.active('enrichment');
    if (running) return running;
    return this.jobs.start('enrichment', 'Checking sources, stars and updates', async ({ progress }) => {
      const { inventory } = await this.current();
      const result = await this.enrichment.refresh(inventory, progress);
      this.events.emit({ type: 'enrichment', fetchedAt: result.fetchedAt ?? new Date().toISOString() });
    }).job;
  }

  async log(entry: Omit<ActivityEntry, 'id' | 'at'>): Promise<ActivityEntry> {
    const full: ActivityEntry = { id: newId('a_'), at: new Date().toISOString(), ...entry };
    await recordActivity(full);
    this.events.emit({ type: 'activity', entry: full });
    return full;
  }

  /** Startup housekeeping: old quarantine downloads and trash past 30 days. */
  async housekeeping(): Promise<void> {
    await Promise.allSettled([this.quarantine.sweep(), vault.sweepTrash()]);
    const prefs = await settings.get();
    if (prefs.network.enabled) {
      const state = await this.enrichment.get(true);
      const stale = !state.fetchedAt || Date.now() - Date.parse(state.fetchedAt) > 24 * 60 * 60 * 1000;
      if (stale) this.startEnrichment();
    }
  }

  /**
   * Watches skill folders, settings and config files, and nothing else: a project's `.claude` folder can be
   * a profile folder (the home directory is often a project) whose transcripts change every second.
   * `.claude.json` is rewritten by every session, so it only triggers a rescan when its MCP sections change.
   */
  private async rewatch(inventory: Inventory): Promise<void> {
    const targets = new Map<string, { recursive: boolean; isConfig: boolean }>();
    const profileDirs = new Set(inventory.profiles.map((p) => p.configDir));
    for (const p of inventory.profiles) {
      if (p.skillsRealDir) targets.set(p.skillsRealDir, { recursive: true, isConfig: false });
      targets.set(join(p.configDir, 'settings.json'), { recursive: false, isConfig: false });
      targets.set(join(p.configDir, 'plugins', 'installed_plugins.json'), { recursive: false, isConfig: false });
      targets.set(p.configFile, { recursive: false, isConfig: true });
    }
    for (const project of inventory.projects) {
      const dotClaude = join(project, '.claude');
      if (profileDirs.has(dotClaude)) continue;
      targets.set(join(dotClaude, 'skills'), { recursive: true, isConfig: false });
      targets.set(join(dotClaude, 'commands'), { recursive: true, isConfig: false });
      targets.set(join(dotClaude, 'settings.json'), { recursive: false, isConfig: false });
      targets.set(join(dotClaude, 'settings.local.json'), { recursive: false, isConfig: false });
      targets.set(join(project, '.mcp.json'), { recursive: false, isConfig: false });
    }
    const key = [...targets.keys()].sort().join('\n');
    if (key === this.watchKey) return;
    this.stopWatching();
    // Seed the MCP-section hashes so the first unrelated rewrite of .claude.json is not taken as a change.
    for (const p of inventory.profiles) await this.mcpSectionChanged(p.configFile);
    for (const [target, { recursive, isConfig }] of targets) {
      if (!(await exists(target))) continue;
      try {
        const watcher = watch(target, { recursive, persistent: false }, (_event, filename) => {
          // Python caches, virtualenvs and package folders inside a skill change when its scripts run.
          if (filename && IGNORED_CHANGE.test(String(filename))) return;
          this.onChange(target, isConfig);
        });
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        // a folder that cannot be watched is still rescanned on demand
      }
    }
    this.watchKey = key;
  }

  private onChange(target: string, isConfig: boolean): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(async () => {
      this.watchTimer = null;
      if (isConfig && !(await this.mcpSectionChanged(target))) return;
      this.events.emit({ type: 'fs-change', paths: [target] });
      void this.rescan().catch(() => undefined);
    }, 600);
  }

  private async mcpSectionChanged(configFile: string): Promise<boolean> {
    try {
      const json = JSON.parse(await readFile(configFile, 'utf8')) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
      const relevant = JSON.stringify([json.mcpServers ?? null, Object.entries(json.projects ?? {}).map(([k, v]) => [k, v?.mcpServers ?? null])]);
      const hash = createHash('sha1').update(relevant).digest('hex');
      const changed = this.configHashes.get(configFile) !== hash;
      this.configHashes.set(configFile, hash);
      return changed;
    } catch {
      return false;
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.watchKey = '';
  }
}
