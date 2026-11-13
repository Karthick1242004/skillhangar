import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStaticAudit } from '../src/core/audit/static';
import { verdictFromFindings, worseVerdict } from '../src/core/audit/verdict';
import { parseSkillFile } from '../src/core/discovery/frontmatter';
import { walkTree } from '../src/core/tree';

const corpus = join(import.meta.dirname, '..', 'fixtures', 'corpus');
const expected = JSON.parse(await readFile(join(corpus, 'expected.json'), 'utf8')) as { malicious: Record<string, string>; benign: string[] };

async function audit(name: string) {
  const root = join(corpus, name);
  const tree = await walkTree(root);
  const { data } = parseSkillFile(await readFile(join(root, 'SKILL.md'), 'utf8'));
  return runStaticAudit(root, tree, data, 'test');
}

describe('static audit corpus', () => {
  for (const [name, ruleId] of Object.entries(expected.malicious)) {
    it(`flags ${name} with ${ruleId}`, async () => {
      const result = await audit(name);
      expect(result.findings.map((f) => f.ruleId)).toContain(ruleId);
    });
  }

  for (const name of expected.benign) {
    it(`does not flag ${name} as critical or high`, async () => {
      const result = await audit(name);
      const serious = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      expect(serious).toEqual([]);
      expect(result.verdict).toBe('safe');
    });
  }

  it('shows hidden characters in evidence instead of hiding them', async () => {
    const result = await audit('mal-tags');
    const finding = result.findings.find((f) => f.ruleId === 'unicode-tags');
    expect(finding?.evidence).toContain('[TAG s]');
  });

  it('never prints a matched secret in full', async () => {
    const result = await audit('mal-secret');
    const finding = result.findings.find((f) => f.ruleId === 'hardcoded-secret');
    expect(finding?.evidence).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('verdicts', () => {
  it('maps severities to verdicts', () => {
    expect(verdictFromFindings([{ severity: 'critical' }])).toBe('dangerous');
    expect(verdictFromFindings([{ severity: 'high' }])).toBe('caution');
    expect(verdictFromFindings([{ severity: 'medium' }, { severity: 'low' }])).toBe('safe');
  });

  it('never lets a model lower a static verdict', () => {
    expect(worseVerdict('safe', 'dangerous')).toBe('dangerous');
    expect(worseVerdict('dangerous', 'safe')).toBe('dangerous');
    expect(worseVerdict('unknown', 'caution')).toBe('caution');
  });
});
