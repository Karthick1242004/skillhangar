import { open } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { RULES, RULESET_VERSION, revealHidden, type FileContext, type FileKind, type RuleHit } from './rules';
import { countBySeverity, verdictFromFindings } from './verdict';
import { toSkillMeta } from '../discovery/frontmatter';
import type { TreeWalk } from '../tree';
import { mapLimit } from '../util/limit';
import type { Finding, StaticAudit } from '../../shared/types';

const MAX_SCANNED_BYTES = 1024 * 1024;
const MAX_HITS_PER_RULE_PER_FILE = 5;
const EVIDENCE_MAX = 220;

function kindOf(rel: string, script: boolean): FileKind {
  if (rel === 'SKILL.md') return 'skill-md';
  if (/\.(md|mdx|markdown|txt)$/i.test(rel)) return 'markdown';
  if (script) return 'script';
  return 'other';
}

async function readScannable(path: string): Promise<{ text: string; binary: boolean; large: boolean } | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_SCANNED_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    // A NUL byte in the first 8 KB marks a binary file, the same test git uses.
    if (buffer.subarray(0, 8192).includes(0)) return { text: '', binary: true, large: false };
    return { text: buffer.toString('utf8'), binary: false, large: size > MAX_SCANNED_BYTES };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Blanks comment-only lines (line comments, block comments, `--`) and keeps the line count, so numbers still line up. */
export function stripComments(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      return '';
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      return '';
    }
    if (/^(\/\/|#(?!!)|\*|--\s|;|rem\s)/i.test(t)) return '';
    return line;
  });
}

function clip(text: string): string {
  const shown = revealHidden(text.trim());
  return shown.length > EVIDENCE_MAX ? `${shown.slice(0, EVIDENCE_MAX)}…` : shown;
}

export function scanFile(file: FileContext): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const severity = rule.severity[file.kind];
    if (!severity) continue;
    let hits: RuleHit[] = [];
    if (rule.check) hits = rule.check(file);
    else if (rule.pattern) {
      const lines = rule.codeOnly && file.kind === 'script' ? file.codeLines : file.lines;
      for (let i = 0; i < lines.length && hits.length < MAX_HITS_PER_RULE_PER_FILE; i++) {
        if (rule.pattern.test(lines[i]!)) hits.push({ line: i + 1, evidence: file.lines[i]! });
      }
    }
    for (const hit of hits.slice(0, MAX_HITS_PER_RULE_PER_FILE)) {
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: hit.severity ?? severity,
        file: file.rel,
        line: hit.line,
        evidence: clip(hit.evidence),
        reason: hit.reason ?? rule.reason,
        fix: rule.fix,
        source: 'static',
      });
    }
  }
  return findings;
}

/** Checks on the frontmatter: what the skill asks to be allowed to do. */
export function scanFrontmatter(frontmatter: Record<string, unknown>): Finding[] {
  const meta = toSkillMeta(frontmatter);
  const findings: Finding[] = [];
  const base = { file: 'SKILL.md', line: 1, source: 'static' as const };
  const unscopedBash = meta.allowedTools.find((t) => /^Bash(\(\s*\*?\s*(:\s*\*)?\s*\))?$/i.test(t));
  if (unscopedBash) {
    findings.push({ ...base, ruleId: 'allowed-tools-bash', category: 'over-privileged', severity: 'medium', evidence: `allowed-tools: ${meta.allowedTools.join(', ')}`, reason: 'Pre-approves every shell command while the skill is active, so any command runs without a prompt.', fix: 'Scope the grant to the commands the skill runs, such as Bash(git status:*).' });
  }
  const broad = meta.allowedTools.filter((t) => /^(Write|Edit|WebFetch|WebSearch|NotebookEdit)$/i.test(t) || /^mcp__\w*\*?$/.test(t));
  if (broad.length) {
    findings.push({ ...base, ruleId: 'allowed-tools-broad', category: 'over-privileged', severity: 'medium', evidence: `allowed-tools: ${broad.join(', ')}`, reason: `Pre-approves ${broad.join(', ')} without a path or domain, so those calls skip the permission prompt.`, fix: 'Scope each tool to the paths or domains the skill needs.' });
  }
  if (meta.hasHooks) {
    findings.push({ ...base, ruleId: 'frontmatter-hooks', category: 'execution-surface', severity: 'medium', evidence: 'hooks: …', reason: 'Registers hooks when the skill is invoked; they keep running for the rest of the session.', fix: 'Read each hook command and confirm it is expected.' });
  }
  if (meta.shell === 'powershell') {
    findings.push({ ...base, ruleId: 'frontmatter-shell', category: 'execution-surface', severity: 'low', evidence: 'shell: powershell', reason: 'Inline commands in this skill run through PowerShell.', fix: 'Confirm the inline commands are read-only.' });
  }
  return findings;
}

/** Checks on the file tree: native code, links that leave the folder, unscanned vendored code. */
export function scanTree(tree: TreeWalk): Finding[] {
  const findings: Finding[] = [];
  for (const f of tree.files) {
    if (f.native) {
      findings.push({ ruleId: 'native-binary', category: 'supply-chain', severity: 'medium', file: f.rel, reason: 'Ships compiled native code that cannot be reviewed as text.', fix: 'Prefer skills that build from source or use published packages.', source: 'static' });
    }
    if (f.kind === 'symlink' && f.linkTarget !== undefined) {
      const target = f.linkTarget;
      const depth = f.rel.split('/').length - 1;
      const escapes = isAbsolute(target) || normalize(join('x/'.repeat(depth), target)).startsWith('..');
      if (escapes) {
        findings.push({ ruleId: 'symlink-escape', category: 'credentials', severity: 'high', file: f.rel, evidence: `→ ${target}`, reason: 'A symlink points outside the skill folder, so reading "a skill file" can read any file on the machine.', fix: 'Replace the link with the file it should contain.', source: 'static' });
      }
    }
  }
  if (tree.vendoredFiles.length) {
    findings.push({ ruleId: 'vendored-unscanned', category: 'hygiene', severity: 'info', file: tree.vendoredDirs.join(', '), reason: `${tree.vendoredFiles.length.toLocaleString('en')} files in vendored folders were counted but not scanned.`, fix: 'Run an external scanner, or reinstall dependencies from a lock file.', source: 'static' });
  }
  return findings;
}

export async function runStaticAudit(root: string, tree: TreeWalk | null, frontmatter: Record<string, unknown>, contentHash: string, singleFile?: string): Promise<StaticAudit> {
  const findings: Finding[] = [...scanFrontmatter(frontmatter)];
  const skipped = { vendoredFiles: tree?.vendoredFiles.length ?? 0, largeFiles: 0, binaryFiles: 0 };
  let scannedFiles = 0;

  const targets = singleFile
    ? [{ abs: singleFile, rel: 'SKILL.md', script: false }]
    : (tree?.files ?? []).filter((f) => f.kind === 'text').map((f) => ({ abs: join(root, f.rel), rel: f.rel, script: f.script }));
  if (tree) {
    findings.push(...scanTree(tree));
    skipped.binaryFiles += tree.files.filter((f) => f.kind === 'binary').length;
  }

  const perFile = await mapLimit(targets, 8, async (t) => {
    const content = await readScannable(t.abs);
    if (!content) return [];
    if (content.binary) {
      skipped.binaryFiles++;
      return [];
    }
    if (content.large) skipped.largeFiles++;
    scannedFiles++;
    const kind = kindOf(t.rel, t.script);
    const lines = content.text.split(/\r?\n/);
    return scanFile({ rel: t.rel, kind, text: content.text, lines, codeLines: kind === 'script' ? stripComments(lines) : lines });
  });
  for (const list of perFile) findings.push(...list);

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return {
    contentHash,
    ruleset: RULESET_VERSION,
    at: new Date().toISOString(),
    verdict: verdictFromFindings(findings),
    counts: countBySeverity(findings),
    findings,
    scannedFiles,
    skipped,
  };
}

function severityRank(s: Finding['severity']): number {
  return ['critical', 'high', 'medium', 'low', 'info'].indexOf(s);
}
