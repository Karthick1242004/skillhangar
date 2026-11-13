import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RULESET_VERSION } from './rules';
import { dataPaths } from '../paths';
import { writeFileAtomic } from '../util/fs';
import type { ClaudeAudit, ScannerResult, StaticAudit } from '../../shared/types';

/**
 * Audit results keyed by content hash. A skill whose files have not changed is never re-audited,
 * and a changed file tree gets a new hash, so stale results cannot be shown as current.
 */
export class AuditCache {
  private staticByHash = new Map<string, StaticAudit>();
  private loaded = false;

  private staticDir = () => join(dataPaths.audits(), 'static');
  private claudeDir = () => join(dataPaths.audits(), 'claude');
  private scannerDir = () => join(dataPaths.audits(), 'scanners');

  /** Loads every cached static audit once; they are small and the overview needs all of them. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let files: string[] = [];
    try {
      files = await readdir(this.staticDir());
    } catch {
      return;
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          try {
            const audit = JSON.parse(await readFile(join(this.staticDir(), f), 'utf8')) as StaticAudit;
            if (audit.ruleset === RULESET_VERSION) this.staticByHash.set(audit.contentHash, audit);
          } catch {
            // ignore a corrupt cache entry; it will be recomputed
          }
        }),
    );
  }

  getStatic(contentHash: string): StaticAudit | null {
    return this.staticByHash.get(contentHash) ?? null;
  }

  async putStatic(audit: StaticAudit): Promise<void> {
    this.staticByHash.set(audit.contentHash, audit);
    await writeFileAtomic(join(this.staticDir(), `${audit.contentHash}.json`), JSON.stringify(audit));
  }

  async putClaude(audit: ClaudeAudit): Promise<string> {
    const file = `${audit.contentHash}-${audit.model.replace(/[^\w.-]/g, '_')}-${Date.parse(audit.at)}.json`;
    await writeFileAtomic(join(this.claudeDir(), file), JSON.stringify(audit));
    return file;
  }

  /** All Claude audits for one content hash, newest first. */
  async listClaude(contentHash: string): Promise<ClaudeAudit[]> {
    let files: string[];
    try {
      files = (await readdir(this.claudeDir())).filter((f) => f.startsWith(`${contentHash}-`));
    } catch {
      return [];
    }
    const audits = await Promise.all(files.map((f) => readFile(join(this.claudeDir(), f), 'utf8').then((t) => JSON.parse(t) as ClaudeAudit).catch(() => null)));
    return audits.filter((a): a is ClaudeAudit => !!a).sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Every Claude audit on disk, newest first, for the audit history screen. */
  async listAllClaude(limit = 200): Promise<ClaudeAudit[]> {
    let files: string[];
    try {
      files = await readdir(this.claudeDir());
    } catch {
      return [];
    }
    const newest = files
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => Number(b.split('-').pop()!.replace('.json', '')) - Number(a.split('-').pop()!.replace('.json', '')))
      .slice(0, limit);
    const audits = await Promise.all(newest.map((f) => readFile(join(this.claudeDir(), f), 'utf8').then((t) => JSON.parse(t) as ClaudeAudit).catch(() => null)));
    return audits.filter((a): a is ClaudeAudit => !!a);
  }

  async putScanner(contentHash: string, result: ScannerResult): Promise<void> {
    await writeFileAtomic(join(this.scannerDir(), `${contentHash}-${result.scanner}.json`), JSON.stringify(result));
  }

  async listScanners(contentHash: string): Promise<ScannerResult[]> {
    let files: string[];
    try {
      files = (await readdir(this.scannerDir())).filter((f) => f.startsWith(`${contentHash}-`));
    } catch {
      return [];
    }
    const results = await Promise.all(files.map((f) => readFile(join(this.scannerDir(), f), 'utf8').then((t) => JSON.parse(t) as ScannerResult).catch(() => null)));
    return results.filter((r): r is ScannerResult => !!r);
  }
}
