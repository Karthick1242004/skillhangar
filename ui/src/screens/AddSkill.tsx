import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api } from '../api';
import { AuditDialog } from '../components/AuditDialog';
import { DestinationPicker } from '../components/Destination';
import { FindingList } from '../components/Findings';
import { Empty, ErrorBox, TitleRow, useAction, useToast, VerdictPill } from '../components/ui';
import { useJobs, useSettings } from '../lib/data';
import type { InstallDestination, QuarantineItem, QuarantineSkill } from '@shared/types';

const EXAMPLES = ['anthropics/skills@skill-creator', 'https://github.com/owner/repo/tree/main/skills/name', '~/code/my-skill'];

export function AddSkill() {
  const settings = useSettings();
  const [source, setSource] = useState('');
  const [item, setItem] = useState<QuarantineItem | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [destination, setDestination] = useState<InstallDestination | null>(null);
  const [mode, setMode] = useState<'copy' | 'symlink'>('copy');
  const [ack, setAck] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const { run, busy } = useAction();
  const toast = useToast();
  const [, navigate] = useLocation();

  const skill = item?.skills.find((s) => s.relPath === selected) ?? null;

  const fetchSource = async () => {
    setError(null);
    setItem(null);
    setAck(false);
    try {
      const result = await api.fetchSource(source);
      setItem(result);
      setSelected(result.skills.length === 1 ? result.skills[0]!.relPath : null);
    } catch (e) {
      setError(e);
    }
  };

  const discard = async () => {
    if (item) await api.discard(item.id).catch(() => undefined);
    setItem(null);
    setSelected(null);
  };

  const install = async () => {
    if (!item || !skill || !destination) return;
    const result = await run('install', () => api.install({ quarantineId: item.id, relPath: skill.relPath, destination, mode, acknowledgeRisk: ack }));
    if (result) {
      toast(`Installed ${skill.name} at ${result.path}.`);
      navigate('/library');
    }
  };

  return (
    <div className="page">
      <TitleRow
        title="Add a skill"
        lede="Downloads go to quarantine first. Nothing reaches a skills folder until you have seen the audit and chosen where it goes."
      />
      {settings.data && !settings.data.network.enabled ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          Downloading from GitHub needs network lookups, which are off. <a className="link" href="#/settings">Turn them on</a>, or add a skill from a folder on this machine.
        </p>
      ) : null}
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void run('fetch', fetchSource);
        }}
      >
        <input className="input grow" style={{ minWidth: 260 }} value={source} onChange={(e) => setSource(e.target.value)} placeholder={EXAMPLES[0]} aria-label="Source" aria-describedby="source-hint" />
        <button className="btn btn-primary" type="submit" disabled={!source.trim() || busy === 'fetch'}>
          {busy === 'fetch' ? 'Fetching and auditing…' : 'Fetch'}
        </button>
      </form>
      <p className="faint" id="source-hint" style={{ fontSize: 12, marginTop: -4, marginBottom: 20 }}>
        A GitHub repository, owner/repo@skill, a link to a folder on GitHub, a skills.sh page, or a local folder path.
      </p>
      {error ? <ErrorBox error={error} /> : null}

      {item ? (
        <div className="grid grid-2-1">
          <div className="stack">
            <section className="panel">
              <div className="panel-head">
                <h2>{item.skills.length === 1 ? 'Found one skill' : `Found ${item.skills.length} skills`}</h2>
                <span className="meta mono">
                  {item.source.kind === 'github' ? `${item.source.owner}/${item.source.repo}${item.commit ? ` @ ${item.commit.slice(0, 10)}` : ''}` : item.source.path}
                </span>
              </div>
              <div className="panel-body">
                <ul className="attention">
                  {item.skills.map((s) => (
                    <li key={s.relPath}>
                      <input type="radio" name="skill" checked={selected === s.relPath} onChange={() => setSelected(s.relPath)} aria-label={`Choose ${s.name}`} style={{ marginTop: 4 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="what">{s.name}</div>
                        <div className="why">{s.description.slice(0, 220) || 'No description'}</div>
                        <div className="cell-sub mono">{s.relPath || '(repository root)'}</div>
                      </div>
                      <VerdictPill verdict={s.audit.verdict} />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
            {skill ? <QuarantineAudit skill={skill} onAudit={() => setAuditOpen(true)} /> : null}
          </div>

          <section className="panel">
            <div className="panel-head"><h2>Install</h2></div>
            <div className="panel-body stack">
              {skill ? (
                <>
                  <DestinationPicker value={destination} onChange={setDestination} mode={mode} onModeChange={setMode} />
                  {skill.audit.verdict === 'dangerous' ? (
                    <label className="check">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      <span>The audit marked this skill dangerous. I read the findings and want to install it anyway.</span>
                    </label>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" disabled={!destination || busy === 'install' || (skill.audit.verdict === 'dangerous' && !ack) || (destination.kind === 'project' && !destination.path)} onClick={install}>
                      {busy === 'install' ? 'Installing…' : `Install ${skill.name}`}
                    </button>
                    <button className="btn" onClick={discard}>
                      Discard
                    </button>
                  </div>
                </>
              ) : (
                <Empty title="Choose a skill on the left." />
              )}
            </div>
          </section>
        </div>
      ) : !error ? (
        <Empty title="Nothing fetched yet.">Paste a source above. Fetching downloads an exact commit, never runs anything, and audits every file.</Empty>
      ) : null}

      {item && skill ? (
        <AuditDialog
          open={auditOpen}
          onClose={() => setAuditOpen(false)}
          subject={skill.name}
          onStart={async (options) => {
            setAuditOpen(false);
            if (await run('qaudit', () => api.auditQuarantine(item.id, skill.relPath, options))) toast(`Claude is auditing ${skill.name}.`);
          }}
        />
      ) : null}
    </div>
  );
}

function QuarantineAudit({ skill, onAudit }: { skill: QuarantineSkill; onAudit: () => void }) {
  const jobs = useJobs();
  const job = (jobs.data ?? []).find((j) => j.kind === 'claude-audit' && j.targetId === skill.contentHash);
  const audits = useQuery({ queryKey: ['audit-hash', skill.contentHash, job?.state], queryFn: () => api.auditsByHash(skill.contentHash) });
  const latest = audits.data?.audits[0];
  const running = job && (job.state === 'running' || job.state === 'queued');
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Audit of {skill.name}</h2>
        <button className="btn btn-sm" disabled={!!running} onClick={onAudit}>
          {running ? 'Claude is auditing…' : latest ? 'Audit again with Claude' : 'Audit with Claude'}
        </button>
      </div>
      <div className="panel-body stack" style={{ gap: 12 }}>
        {job?.state === 'failed' ? <ErrorBox error={new Error(job.error)} /> : null}
        {latest ? (
          <div className="stack" style={{ gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <VerdictPill verdict={latest.combinedVerdict} />
              <span className="muted">Claude ({latest.model}){latest.costUsd !== null ? ` · $${latest.costUsd.toFixed(4)}` : ''}</span>
            </div>
            <p>{latest.summary}</p>
            <FindingList findings={latest.findings} emptyText="Claude found nothing to report." />
          </div>
        ) : null}
        <h3 style={{ fontSize: 14 }}>Static rules</h3>
        <FindingList findings={skill.audit.findings} emptyText="The static rules found nothing." />
      </div>
    </section>
  );
}
