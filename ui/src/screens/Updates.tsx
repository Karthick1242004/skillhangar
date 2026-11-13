import { useMemo, useState } from 'react';
import { api } from '../api';
import { UpdateDialog } from '../components/UpdateDialog';
import { Empty, ErrorBox, TitleRow, useAction } from '../components/ui';
import { useJobs, useSkillViews } from '../lib/data';
import { ago, date, n, plural } from '../lib/format';

export function Updates() {
  const { skills, enrichment, error } = useSkillViews();
  const jobs = useJobs();
  const { run } = useAction();
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const checking = (jobs.data ?? []).some((j) => j.kind === 'enrichment' && (j.state === 'running' || j.state === 'queued'));

  const { available, current, untracked } = useMemo(() => {
    const live = skills.filter((s) => !s.shadowedBy && s.scope !== 'agents-store');
    return {
      available: live.filter((s) => s.update?.state === 'available'),
      current: live.filter((s) => s.update?.state === 'up-to-date').length,
      untracked: live.filter((s) => !s.update || s.update.state === 'untracked' || s.update.state === 'unknown').length,
    };
  }, [skills]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (enrichment && !enrichment.enabled) {
    return (
      <div className="page">
        <TitleRow title="Updates" />
        <Empty title="Update checks need network lookups.">
          Skillhangar compares each skill's folder with its source on GitHub. <a className="link" href="#/settings">Turn on network lookups</a>.
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <TitleRow
        title="Updates"
        lede={
          available.length ? (
            <>
              <strong>{plural(available.length, 'update')} available.</strong> Each one is downloaded to quarantine, diffed and re-audited before you apply it.
            </>
          ) : (
            `${plural(current, 'skill')} up to date. ${n(untracked)} have no source to compare against.`
          )
        }
        actions={
          <>
            {enrichment?.fetchedAt ? <span className="stamp">Checked {ago(enrichment.fetchedAt)}</span> : null}
            <button className="btn btn-primary" disabled={checking} onClick={() => run('check', api.refreshEnrichment)}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </>
        }
      />
      {enrichment?.errors.length ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          {enrichment.errors.slice(0, 3).map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : null}
      {available.length ? (
        <table className="table responsive">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Source</th>
              <th>Latest change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {available.map((s) => (
              <tr key={s.id}>
                <td>
                  <a className="cell-title" href={`#/skills/${s.id}`}>{s.name}</a>
                  <div className="cell-sub">Installed {date(s.installedAt)}</div>
                </td>
                <td className="secondary">{s.provenance?.source}</td>
                <td className="hide-phone" style={{ maxWidth: 360 }}>
                  <div className="truncate">{s.update?.latestMessage ?? <span className="faint">—</span>}</div>
                  <div className="cell-sub">{date(s.update?.latestDate)}</div>
                </td>
                <td className="cell-actions">
                  <button className="btn btn-sm" onClick={() => setOpen({ id: s.id, name: s.name })}>
                    Review update
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title={enrichment?.fetchedAt ? 'Everything with a known source is current.' : 'Not checked yet.'}>
          {untracked ? `${plural(untracked, 'skill')} cannot be checked because no source was recorded. Open one and use Trace origin.` : null}
        </Empty>
      )}
      {open ? <UpdateDialog open onClose={() => setOpen(null)} skillId={open.id} name={open.name} /> : null}
    </div>
  );
}
