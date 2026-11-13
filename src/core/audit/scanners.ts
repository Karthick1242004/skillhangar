import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { VENDORED_DIRS } from '../tree';
import { run, which } from '../util/proc';
import type { Finding, FindingCategory, ScannerResult, Severity } from '../../shared/types';

export interface ScannerSpec {
  id: 'cisco' | 'skillspector';
  label: string;
  /** What uvx installs, pinned so a new publish (or a look-alike package) cannot change what runs. */
  from: string;
  bin: string;
  args: (target: string, output: string) => string[];
  homepage: string;
}

/**
 * External scanners, always run through `uvx` at a pinned version. Cisco's package is
 * `cisco-ai-skill-scanner`; the unrelated `skill-scanner` package on PyPI installs a command with the same
 * name, which is why Skillhangar never runs whatever `skill-scanner` happens to be on PATH.
 */
export const SCANNERS: ScannerSpec[] = [
  {
    id: 'cisco',
    label: 'Cisco AI Defense skill-scanner 2.3.2',
    from: 'cisco-ai-skill-scanner==2.3.2',
    bin: 'skill-scanner',
    args: (target, output) => ['scan', target, '--format', 'sarif', '--output', output],
    homepage: 'https://github.com/cisco-ai-defense/skill-scanner',
  },
  {
    id: 'skillspector',
    label: 'NVIDIA SkillSpector 2.12.0',
    from: 'git+https://github.com/NVIDIA/skillspector.git@9dc82fe473329b2b742aa5097dcfe7ae55f51b01',
    bin: 'skillspector',
    args: (target, output) => ['scan', target, '--no-llm', '--format', 'sarif', '--output', output],
    homepage: 'https://github.com/NVIDIA/SkillSpector',
  },
];

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; snippet?: { text?: string } } } }[];
  properties?: Record<string, unknown>;
}

interface SarifLog {
  runs?: { tool?: { driver?: { rules?: { id?: string; properties?: Record<string, unknown> }[] } }; results?: SarifResult[] }[];
}

const CATEGORY_KEYWORDS: [RegExp, FindingCategory][] = [
  [/hidden|unicode|stegan|invisible/i, 'hidden-instructions'],
  [/prompt|instruction|jailbreak|manipulat/i, 'prompt-injection'],
  [/exfil|leak|transmi/i, 'exfiltration'],
  [/secret|hardcoded/i, 'secrets'],
  [/credential|token|password|keychain/i, 'credentials'],
  [/obfusc|encod|base64/i, 'obfuscation'],
  [/persist|startup|cron|hook/i, 'persistence'],
  [/destruct|delet|wipe/i, 'destructive'],
  [/permission|privilege|scope|allowed[-_ ]?tools/i, 'over-privileged'],
  [/supply|dependen|package|pin|version/i, 'supply-chain'],
  [/command|exec|rce|script|download|fetch|chain/i, 'remote-code'],
];

function categoryOf(text: string): FindingCategory {
  return CATEGORY_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'hygiene';
}

function severityOf(result: SarifResult, ruleProps: Record<string, unknown> | undefined): Severity {
  const named = String(result.properties?.severity ?? '').toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info'].includes(named)) return named as Severity;
  // GitHub's convention: a numeric "security-severity" from 0 to 10.
  const score = Number(result.properties?.['security-severity'] ?? ruleProps?.['security-severity']);
  if (Number.isFinite(score) && score > 0) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return result.level === 'error' ? 'high' : result.level === 'warning' ? 'medium' : result.level === 'note' ? 'low' : 'info';
}

/** Maps any SARIF 2.1 log onto Skillhangar findings. Paths are made relative to the skill folder. */
export function sarifToFindings(log: SarifLog, scanner: string, subjectName: string): Finding[] {
  const findings: Finding[] = [];
  for (const runEntry of log.runs ?? []) {
    const rules = new Map((runEntry.tool?.driver?.rules ?? []).map((r) => [r.id ?? '', r.properties]));
    for (const result of runEntry.results ?? []) {
      const location = result.locations?.[0]?.physicalLocation;
      let file = location?.artifactLocation?.uri ?? 'SKILL.md';
      file = file.replace(/^file:\/\//, '').replace(/^\.\//, '');
      if (file.startsWith(`${subjectName}/`)) file = file.slice(subjectName.length + 1);
      const props = result.properties ?? {};
      const message = result.message?.text ?? result.ruleId ?? 'Finding';
      const explanation = typeof props.explanation === 'string' ? props.explanation : '';
      const evidence = [props.code_snippet, location?.region?.snippet?.text, props.evidence].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      findings.push({
        ruleId: result.ruleId ?? 'unknown',
        category: categoryOf(`${String(props.category ?? '')} ${result.ruleId ?? ''} ${message}`),
        severity: severityOf(result, rules.get(result.ruleId ?? '')),
        file,
        line: location?.region?.startLine ?? undefined,
        evidence: evidence?.trim().slice(0, 400),
        reason: (explanation && !explanation.startsWith(message) ? `${message.replace(/[.\s]+$/, '')}. ${explanation}` : message).slice(0, 1200),
        fix: typeof props.remediation === 'string' ? props.remediation.slice(0, 600) : undefined,
        source: `scanner:${scanner}`,
      });
    }
  }
  return findings;
}

/**
 * Runs one scanner on a copy of the skill (vendored folders left out), in a temporary folder that is
 * deleted afterwards. The first run downloads the scanner into uv's cache; later runs start in seconds.
 */
export async function runScanner(id: ScannerSpec['id'], skillRoot: string, singleFile: boolean, signal?: AbortSignal): Promise<ScannerResult> {
  const spec = SCANNERS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown scanner "${id}".`);
  const at = new Date().toISOString();
  const uvx = await which('uvx');
  if (!uvx) return { scanner: id, at, ok: false, error: 'uvx is not installed. Install uv (https://docs.astral.sh/uv/) to run external scanners.', findings: [] };

  const dir = await mkdtemp(join(tmpdir(), 'skillhangar-scan-'));
  const subjectName = singleFile ? 'skill' : basename(skillRoot) || 'skill';
  const subject = join(dir, subjectName);
  try {
    if (singleFile) await cp(skillRoot, join(subject, 'SKILL.md'));
    else await cp(skillRoot, subject, { recursive: true, verbatimSymlinks: true, filter: (source) => !VENDORED_DIRS.has(basename(source)) });
    const output = join(dir, 'report.sarif');
    const result = await run(uvx, ['--quiet', '--from', spec.from, spec.bin, ...spec.args(subjectName, output)], { cwd: dir, timeoutMs: 10 * 60 * 1000, signal, env: { ...process.env, NO_COLOR: '1' } });
    if (result.aborted) throw new Error('Cancelled.');
    // Both scanners exit non-zero when they find something; a written report is what counts.
    const raw = await readFile(output, 'utf8').catch(() => null);
    if (!raw) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
      return { scanner: id, at, ok: false, error: result.timedOut ? 'The scanner timed out after 10 minutes.' : `The scanner wrote no report (exit ${result.code}). ${detail}`.trim(), findings: [] };
    }
    return { scanner: id, at, ok: true, findings: sarifToFindings(JSON.parse(raw) as SarifLog, id, subjectName) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
