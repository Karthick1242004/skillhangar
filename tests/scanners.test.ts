import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sarifToFindings } from '../src/core/audit/scanners';

const load = async (name: string) => JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', 'sarif', name), 'utf8'));

describe('external scanner SARIF', () => {
  it('reads Cisco skill-scanner output, its named severities and its paths', async () => {
    const findings = sarifToFindings(await load('cisco-mal-pipe-shell.sarif'), 'cisco', 'mal-pipe-shell');
    const flow = findings.find((f) => f.ruleId === 'CORRELATED_NETWORK_EXECUTION_FLOW');
    expect(flow).toMatchObject({ severity: 'high', file: 'scripts/setup.sh', line: 2, category: 'remote-code', source: 'scanner:cisco' });
    expect(findings.find((f) => f.ruleId === 'MANIFEST_MISSING_LICENSE')?.severity).toBe('info');
  });

  it('reads SkillSpector output and its security-severity scores', async () => {
    const findings = sarifToFindings(await load('skillspector-mal-pipe-shell.sarif'), 'skillspector', 'mal-pipe-shell');
    expect(findings.length).toBe(3);
    expect(findings.find((f) => f.ruleId === 'SC2')).toMatchObject({ file: 'scripts/setup.sh', line: 2 });
    expect(findings.every((f) => f.source === 'scanner:skillspector')).toBe(true);
    expect(['critical', 'high']).toContain(findings.find((f) => f.ruleId === 'SC2')!.severity);
  });
});
