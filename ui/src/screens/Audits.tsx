import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { AuditDialog } from '../components/AuditDialog';
import { Empty, ErrorBox, TitleRow, useAction, useToast, VerdictPill } from '../components/ui';
import { keys, useJobs, useSkillViews } from '../lib/data';
import { ago, n, plural } from '../lib/format';

export function Audits() {
  const { skills, error } = useSkillViews();
  const history = useQuery({ queryKey: keys.audits, queryFn: api.audits });
  const jobs = useJobs();
  const { run } = useAction();
  const toast = useToast();
  const [auditOpen, setAuditOpen] = useState(false);

  const needsReview = useMemo(() => skills.filter((s) => s.needsReview).sort((a, b) => (a.verdict === 'dangerous' ? -1 : 0) - (b.verdict === 'dangerous' ? -1 : 0) || a.name.localeCompare(b.name)), [skills]);
  const byHash = useMemo(() => new Map(skills.map((s) => [s.contentHash, s])), [skills]);
  const active = (jobs.data ?? []).filter((j) => j.kind === 'claude-audit' && (j.state === 'running' || j.state === 'queued'));
  const failed = (jobs.data ?? []).filter((j) => j.kind === 'claude-audit' && j.state === 'failed').slice(0, 5);
  const spent = (history.data?.audits ?? []).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;

  return (
    <div className="page">
      <TitleRow
        title="Audits"
        lede={
          needsReview.length ? (
            <>
              <strong>{plural(needsReview.length, 'skill')} {needsReview.length === 1 ? 'needs' : 'need'} a decision.</strong> Read the findings, then mark each one reviewed or remove it.
            </>
          ) : (
            'Every skill passed its static audit or was reviewed by you.'
          )
        }
        actions={
          needsReview.length ? (
            <button className="btn btn-primary" onClick={() => setAuditOpen(true)}>
              Audit all {n(needsReview.length)} with Claude
            </button>
          ) : null
        }
      />

      {active.length || failed.length ? (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head"><h2>In progress</h2><span className="meta">Two run at a time</span></div>
          <div className="panel-body">
            <ul className="attention">
              {[...active, ...failed].map((job) => (
                <li key={job.id}>
                  <span className={`sev ${job.state === 'failed' ? 'critical' : 'medium'}`} />
                  <div>
                    <div className="what">{job.label}</div>
                    <div className="why">{job.state === 'failed' ? job.error : job.state}</div>
                  </div>
                  {job.state !== 'failed' ? (
                    <button className="btn btn-sm" onClick={() => run('cancel', () => api.cancelJob(job.id))}>
                      Cancel
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div className="grid grid-1-1">
        <section className="panel">
          <div className="panel-head"><h2>Needs a decision</h2><span className="meta">{n(needsReview.length)}</span></div>
          <div className="panel-body">
            {needsReview.length ? (
              <table className="table responsive">
                <tbody>
                  {needsReview.map((s) => (
                    <tr key={s.id}>
                      <td style={{ maxWidth: 0 }}>
                        <a className="cell-title" href={`#/skills/${s.id}`}>{s.name}</a>
                        <div className="cell-sub">
                          {s.audit ? `${plural(s.audit.counts.critical, 'critical')}, ${plural(s.audit.counts.high, 'high')}` : ''}
                          {s.review?.changedSince ? ' · changed since you reviewed it' : ''}
                        </div>
                      </td>
                      <td><VerdictPill verdict={s.verdict} /></td>
                      <td className="cell-actions">
                        <button className="btn btn-sm" onClick={() => run(`review-${s.id}`, () => api.review(s.id), `${s.name} marked reviewed.`)}>
                          Mark reviewed
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="Nothing waiting." />
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Claude audit history</h2><span className="meta num">${spent.toFixed(4)} spent</span></div>
          <div className="panel-body">
            {history.error ? <ErrorBox error={history.error} /> : null}
            {history.data?.audits.length ? (
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Verdict</th>
                    <th className="num">Cost</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.audits.slice(0, 40).map((a) => {
                    const skill = byHash.get(a.contentHash);
                    return (
                      <tr key={`${a.contentHash}-${a.at}`}>
                        <td style={{ maxWidth: 0 }}>
                          {skill ? <a className="cell-title" href={`#/skills/${skill.id}`}>{skill.name}</a> : <span className="muted">Changed or removed skill</span>}
                          <div className="cell-sub">{a.model} · {(a.durationMs / 1000).toFixed(0)} s</div>
                        </td>
                        <td><VerdictPill verdict={a.combinedVerdict} /></td>
                        <td className="num">{a.costUsd !== null ? `$${a.costUsd.toFixed(4)}` : '—'}</td>
                        <td className="num">{ago(a.at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty title="No Claude audits yet.">Open a skill and choose Audit with Claude.</Empty>
            )}
          </div>
        </section>
      </div>

      <AuditDialog
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        subject="flagged skills"
        count={needsReview.length}
        onStart={async (options) => {
          setAuditOpen(false);
          let started = 0;
          for (const s of needsReview) if (await run(`audit-${s.id}`, () => api.audit(s.id, options))) started++;
          if (started) toast(`Started ${plural(started, 'Claude audit')}.`);
        }}
      />
    </div>
  );
}
