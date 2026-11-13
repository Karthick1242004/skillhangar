import { useState } from 'react';
import { SeverityLabel, Empty } from './ui';
import type { Finding } from '@shared/types';

const CATEGORY_LABEL: Record<Finding['category'], string> = {
  'hidden-instructions': 'Hidden instructions',
  'prompt-injection': 'Prompt injection',
  exfiltration: 'Data exfiltration',
  credentials: 'Credential access',
  'remote-code': 'Remote code',
  obfuscation: 'Obfuscation',
  persistence: 'Persistence',
  destructive: 'Destructive',
  'over-privileged': 'Over-privileged',
  'execution-surface': 'Runs code',
  'supply-chain': 'Supply chain',
  secrets: 'Secret in files',
  mismatch: 'Does more than it says',
  hygiene: 'Housekeeping',
};

export function FindingList({ findings, onOpenFile, emptyText = 'No findings.' }: { findings: Finding[]; onOpenFile?: (file: string, line?: number) => void; emptyText?: string }) {
  const [showLow, setShowLow] = useState(false);
  const serious = findings.filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium');
  const minor = findings.filter((f) => f.severity === 'low' || f.severity === 'info');
  const visible = showLow ? findings : serious;
  if (!findings.length) return <Empty title={emptyText} />;
  return (
    <div>
      {visible.map((f, i) => (
        <article key={`${f.ruleId}-${f.file}-${f.line}-${i}`} className="finding">
          <div className="finding-head">
            <SeverityLabel severity={f.severity} />
            <span className="rule">{CATEGORY_LABEL[f.category]}</span>
            <span className="tag">{f.source === 'static' ? f.ruleId : f.source}</span>
            {onOpenFile && f.file && !f.file.includes(',') ? (
              <button className="link mono" onClick={() => onOpenFile(f.file, f.line)}>
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </button>
            ) : (
              <span className="mono muted">
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </span>
            )}
          </div>
          <p>{f.reason}</p>
          {f.evidence ? <pre>{f.evidence}</pre> : null}
          {f.fix ? <p className="muted">Fix: {f.fix}</p> : null}
        </article>
      ))}
      {!serious.length && !showLow ? <Empty title="No findings above low severity." /> : null}
      {minor.length ? (
        <button className="link" style={{ marginTop: 10 }} onClick={() => setShowLow((v) => !v)}>
          {showLow ? 'Hide' : 'Show'} {minor.length} low and informational
        </button>
      ) : null}
    </div>
  );
}
