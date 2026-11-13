import { VERDICT_RANK, type Finding, type Severity, type Verdict } from '../../shared/types';

/** Critical makes a skill dangerous; high asks for review; medium and below are notes. */
export function verdictFromFindings(findings: readonly Pick<Finding, 'severity'>[]): Verdict {
  if (findings.some((f) => f.severity === 'critical')) return 'dangerous';
  if (findings.some((f) => f.severity === 'high')) return 'caution';
  return 'safe';
}

export function countBySeverity(findings: readonly Pick<Finding, 'severity'>[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** The worse of two verdicts. A model's opinion can raise a verdict, never lower one. */
export function worseVerdict(a: Verdict, b: Verdict): Verdict {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}
