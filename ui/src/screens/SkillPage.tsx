import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, type OriginCandidate } from '../api';
import { AuditDialog } from '../components/AuditDialog';
import { CodeView } from '../components/CodeView';
import { DestinationPicker } from '../components/Destination';
import { FindingList } from '../components/Findings';
import { Icon } from '../components/icons';
import { UpdateDialog } from '../components/UpdateDialog';
import { Dialog, Empty, ErrorBox, Tabs, TitleRow, useAction, useToast, VerdictPill } from '../components/ui';
import { effectiveVerdict, keys, useEnrichment, useJobs } from '../lib/data';
import { ago, bytes, compact, date, n, plural, SCOPE_LABEL, tildify } from '../lib/format';
import type { InstallDestination, SkillDetail, SkillOverride } from '@shared/types';

type TabId = 'overview' | 'audit' | 'skillmd' | 'files' | 'history';

const OVERRIDE_LABEL: Record<SkillOverride, string> = {
  on: 'Listed to Claude',
  'name-only': 'Name only',
  'user-invocable-only': 'Only when typed as /command',
  off: 'Off',
};

export function SkillPage({ id }: { id: string }) {
  const detail = useQuery({ queryKey: keys.skill(id), queryFn: () => api.skill(id) });
  const [tab, setTab] = useState<TabId>('overview');
  const [file, setFile] = useState<{ path: string; line?: number } | null>(null);

  if (detail.error) return <div className="page"><ErrorBox error={detail.error} /><p style={{ marginTop: 12 }}><a className="link" href="#/library">Back to all skills</a></p></div>;
  if (!detail.data) return <div className="page" aria-busy="true"><TitleRow title={<span className="skeleton" style={{ width: 220, height: 26 }} />} /></div>;
  const d = detail.data;
  const allFindings = [...d.staticAudit.findings, ...(d.claudeAudits[0]?.contentHash === d.skill.contentHash ? d.claudeAudits[0].findings : [])];

  const openFile = (path: string, line?: number) => {
    if (path === 'SKILL.md') setTab('skillmd');
    else {
      setFile({ path, line });
      setTab('files');
    }
  };

  return (
    <div className="page">
      <Header d={d} onTab={setTab} />
      <Tabs
        label="Skill"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'audit', label: 'Audit', count: allFindings.filter((f) => f.severity !== 'info' && f.severity !== 'low').length },
          { id: 'skillmd', label: 'SKILL.md' },
          { id: 'files', label: 'Files', count: d.skill.files.count },
          { id: 'history', label: 'History' },
        ]}
      />
      {tab === 'overview' ? <OverviewTab d={d} /> : null}
      {tab === 'audit' ? <AuditTab d={d} onOpenFile={openFile} /> : null}
      {tab === 'skillmd' ? (
        <CodeView text={d.skillMd} label="SKILL.md" flagged={new Set(allFindings.filter((f) => f.file === 'SKILL.md' && f.line).map((f) => f.line!))} />
      ) : null}
      {tab === 'files' ? <FilesTab d={d} selected={file} onSelect={setFile} findingsFor={(p) => new Set(allFindings.filter((f) => f.file === p && f.line).map((f) => f.line!))} /> : null}
      {tab === 'history' ? <HistoryTab d={d} /> : null}
    </div>
  );
}

function Header({ d, onTab }: { d: SkillDetail; onTab: (t: TabId) => void }) {
  const s = d.skill;
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { run, busy } = useAction();
  const toast = useToast();
  const jobs = useJobs();
  const [dialog, setDialog] = useState<null | 'audit' | 'update' | 'remove' | 'copy' | 'trace'>(null);
  const auditing = (jobs.data ?? []).some((j) => j.kind === 'claude-audit' && j.targetId === s.id && (j.state === 'running' || j.state === 'queued'));
  const verdict = effectiveVerdict(s);
  const reviewed = !!s.review && !s.review.changedSince;
  const removable = ['personal', 'project', 'legacy-command', 'agents-store'].includes(s.scope);

  return (
    <>
      <TitleRow
        crumbs={
          <>
            <a href="#/library">Skills</a>
            <Icon name="chevron" size={12} />
            <span>{SCOPE_LABEL[s.scope]}</span>
          </>
        }
        title={s.name}
        lede={
          <>
            <VerdictPill verdict={verdict} reviewed={reviewed} />{' '}
            <span className="mono" style={{ marginLeft: 6 }}>{tildify(s.path)}</span>
            {s.isSymlink ? <span className="faint"> → {tildify(s.realPath)}</span> : null}
          </>
        }
        actions={
          <>
            {s.provenance?.github && s.provenance.kind !== 'plugin' ? (
              <button className="btn" onClick={() => setDialog('update')}>
                Check for update
              </button>
            ) : null}
            {!s.provenance && s.scope !== 'plugin' ? (
              <button className="btn" onClick={() => setDialog('trace')}>
                Trace origin
              </button>
            ) : null}
            <button className="btn btn-primary" disabled={auditing} onClick={() => setDialog('audit')}>
              {auditing ? 'Audit running…' : 'Audit with Claude'}
            </button>
          </>
        }
      />
      <div className="toolbar" style={{ marginTop: -8 }}>
        {(verdict === 'caution' || verdict === 'dangerous') && !reviewed ? (
          <button className="btn btn-sm" disabled={busy === 'review'} onClick={() => run('review', () => api.review(s.id), 'Marked as reviewed. It will be flagged again if its files change.')}>
            <Icon name="check" size={14} /> Mark reviewed
          </button>
        ) : null}
        {s.scope !== 'plugin' && s.scope !== 'agents-store' ? (
          <label className="check" style={{ alignItems: 'center', gap: 8 }}>
            <span className="muted">Visibility</span>
            <select
              className="select"
              style={{ height: 28 }}
              value={s.override}
              disabled={busy === 'override'}
              onChange={(e) => run('override', () => api.override(s.id, e.target.value as SkillOverride), `${s.name}: ${OVERRIDE_LABEL[e.target.value as SkillOverride]}`)}
            >
              {(Object.keys(OVERRIDE_LABEL) as SkillOverride[]).map((v) => (
                <option key={v} value={v}>
                  {OVERRIDE_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button className="btn btn-sm" onClick={() => setDialog('copy')}>
          <Icon name="copy" size={14} /> Copy to…
        </button>
        {removable ? (
          <button className="btn btn-sm btn-danger" onClick={() => setDialog('remove')}>
            <Icon name="trash" size={14} /> Remove
          </button>
        ) : null}
      </div>

      <AuditDialog
        open={dialog === 'audit'}
        onClose={() => setDialog(null)}
        subject={s.name}
        onStart={async (options) => {
          setDialog(null);
          if (await run('audit', () => api.audit(s.id, options))) {
            toast(`Claude is auditing ${s.name}.`);
            onTab('audit');
          }
        }}
      />
      <UpdateDialog open={dialog === 'update'} onClose={() => setDialog(null)} skillId={s.id} name={s.name} />
      <CopyDialog open={dialog === 'copy'} onClose={() => setDialog(null)} id={s.id} name={s.name} />
      <TraceDialog open={dialog === 'trace'} onClose={() => setDialog(null)} id={s.id} name={s.name} />
      <Dialog
        open={dialog === 'remove'}
        onClose={() => setDialog(null)}
        title={`Remove ${s.name}?`}
        footer={
          <>
            <button className="btn" onClick={() => setDialog(null)}>
              Keep it
            </button>
            <button
              className="btn btn-danger"
              disabled={busy === 'remove'}
              onClick={async () => {
                const result = await run('remove', () => api.remove(s.id));
                if (result) {
                  setDialog(null);
                  toast(`${s.name} moved to the trash.`, { action: { label: 'Undo', run: () => void api.restoreTrash(result.trashId).then(() => client.invalidateQueries({ queryKey: keys.inventory })) } });
                  navigate('/library');
                }
              }}
            >
              Move to trash
            </button>
          </>
        }
      >
        <p>
          {s.isSymlink ? 'The link at ' : 'The folder '}
          <span className="mono">{tildify(s.path)}</span> moves to Skillhangar's trash. Claude Code stops loading it from the next session. You can restore it from Activity for 30 days.
        </p>
      </Dialog>
    </>
  );
}

function OverviewTab({ d }: { d: SkillDetail }) {
  const s = d.skill;
  const enrichment = useEnrichment();
  const e = enrichment.data;
  const gh = s.provenance?.github;
  const key = gh ? `${gh.owner}/${gh.repo}`.toLowerCase() : null;
  const repo = key ? e?.repos[key] : undefined;
  const trending = key ? (e?.trending[key] ?? []) : [];
  const sh = key ? e?.skillsSh[`${key}/${s.folderName.toLowerCase()}`] : undefined;
  const scorecard = key ? e?.scorecards[key] : undefined;
  const update = e?.updates[s.id];
  const installedBy: Record<string, string> = { lock: 'the skills CLI lock file', skillhangar: 'Skillhangar', plugin: 'the plugin record', git: 'git', 'first-seen': 'first seen on disk' };

  return (
    <div className="grid grid-2-1">
      <div className="stack">
        <section className="panel">
          <div className="panel-head"><h2>What it says it does</h2></div>
          <div className="panel-body">
            <p style={{ whiteSpace: 'pre-wrap' }}>{s.description || <span className="faint">No description.</span>}</p>
            {s.whenToUse ? <p className="muted" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{s.whenToUse}</p> : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Facts</h2></div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Scope</dt>
              <dd>
                {SCOPE_LABEL[s.scope]}
                {s.projectPath ? <span className="muted"> · {tildify(s.projectPath)}</span> : null}
                {s.pluginId ? <span className="muted"> · {s.pluginId}</span> : null}
              </dd>
              <dt>Loaded by</dt>
              <dd>{s.profileIds.length ? s.profileIds.join(', ') : <span className="faint">No profile</span>}</dd>
              <dt>Installed</dt>
              <dd>
                {date(s.installedAt)} <span className="muted">· from {installedBy[s.installedAtSource ?? ''] ?? 'unknown'}</span>
              </dd>
              <dt>Files</dt>
              <dd className="num">
                {plural(s.files.count, 'file')}, {bytes(s.files.bytes)}
                {s.files.scripts ? `, ${plural(s.files.scripts, 'script')}` : ''}
                {s.files.binaries ? `, ${plural(s.files.binaries, 'native binary', 'native binaries')}` : ''}
                {s.files.vendored.files ? <span className="muted"> · {n(s.files.vendored.files)} vendored, not scanned</span> : null}
              </dd>
              <dt>Pre-approved tools</dt>
              <dd>{s.meta.allowedTools.length ? s.meta.allowedTools.map((t) => <span key={t} className="tag mono" style={{ marginRight: 4 }}>{t}</span>) : <span className="faint">None</span>}</dd>
              <dt>Claude may invoke it</dt>
              <dd>{s.meta.disableModelInvocation ? 'No, only as a typed /command' : 'Yes'}</dd>
              <dt>Visibility</dt>
              <dd>{OVERRIDE_LABEL[s.override]}</dd>
              <dt>Listing cost</dt>
              <dd className="num">{n(s.contextChars)} characters{s.contextChars > 1536 ? <span className="faint"> · truncated at 1,536</span> : null}</dd>
              {s.meta.hasHooks ? (
                <>
                  <dt>Hooks</dt>
                  <dd>Registers hooks when invoked</dd>
                </>
              ) : null}
              <dt>Content hash</dt>
              <dd className="mono">{s.contentHash.slice(0, 16)}</dd>
            </dl>
          </div>
        </section>
        {s.health.length ? (
          <section className="panel">
            <div className="panel-head"><h2>Health</h2></div>
            <div className="panel-body">
              <ul className="attention">
                {s.health.map((h) => (
                  <li key={h.code}>
                    <span className={`sev ${h.severity}`} />
                    <div>
                      <div className="what">{h.message}</div>
                    </div>
                    <span />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Source and trust</h2></div>
        <div className="panel-body">
          {s.provenance ? (
            <dl className="kv" style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
              <dt>Source</dt>
              <dd>
                {gh ? (
                  <a className="link" href={`https://github.com/${gh.owner}/${gh.repo}`} target="_blank" rel="noreferrer noopener">
                    {gh.owner}/{gh.repo}
                  </a>
                ) : (
                  s.provenance.source
                )}
              </dd>
              {s.provenance.skillPath ? (<><dt>Path</dt><dd className="mono">{s.provenance.skillPath}</dd></>) : null}
              {s.provenance.commit ? (<><dt>Commit</dt><dd className="mono">{s.provenance.commit.slice(0, 12)}</dd></>) : null}
              <dt>Recorded by</dt>
              <dd>{s.provenance.kind.replace(/-/g, ' ')}</dd>
              {e?.enabled ? (
                <>
                  <dt>Stars</dt>
                  <dd className="num">{repo ? <><Icon name="star" size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> {n(repo.stars)}</> : '—'}</dd>
                  <dt>Licence</dt>
                  <dd>{repo?.license ?? '—'}</dd>
                  <dt>Last push</dt>
                  <dd>{repo ? `${date(repo.pushedAt)}${repo.archived ? ' · archived' : ''}` : '—'}</dd>
                  <dt>GitHub Trending</dt>
                  <dd>
                    {trending.length ? (
                      <>
                        {plural(trending.length, 'day')} · first {date(trending[0])}, last {date(trending[trending.length - 1])}
                      </>
                    ) : e.trendingIndexedThrough ? (
                      <span className="muted">No record in the archive</span>
                    ) : (
                      <a className="link" href="#/settings">Build the trending index</a>
                    )}
                  </dd>
                  <dt>skills.sh</dt>
                  <dd>
                    {sh?.installs !== null && sh?.installs !== undefined ? `${compact(sh.installs)} installs` : '—'}
                    {sh && Object.keys(sh.partners).length ? (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                        {Object.entries(sh.partners).map(([partner, v]) => (
                          <span key={partner} className={`pill ${v.risk === 'safe' || v.risk === 'low' ? 'safe' : v.risk === 'medium' ? 'caution' : v.risk === 'high' || v.risk === 'critical' ? 'dangerous' : ''}`}>
                            {partner}: {v.risk}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </dd>
                  <dt>Scorecard</dt>
                  <dd className="num">{scorecard ? `${scorecard.score.toFixed(1)} of 10` : scorecard === null ? <span className="muted">Not covered</span> : '—'}</dd>
                  <dt>Update</dt>
                  <dd>
                    {update?.state === 'available' ? (
                      <>
                        <span className="pill caution">Available</span>
                        {update.latestMessage ? <div className="cell-sub">{update.latestMessage} · {date(update.latestDate)}</div> : null}
                      </>
                    ) : update?.state === 'up-to-date' ? (
                      'Current'
                    ) : (
                      <span className="muted">{update?.reason ?? 'Not checked'}</span>
                    )}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <Empty title="Origin unknown.">No installer recorded where this skill came from. Use Trace origin to search for it.</Empty>
          )}
          {!e?.enabled ? (
            <p className="notice" style={{ marginTop: 12 }}>
              Stars, trending history, install counts and update checks need network lookups. <a className="link" href="#/settings">Turn them on in Settings</a>.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function AuditTab({ d, onOpenFile }: { d: SkillDetail; onOpenFile: (file: string, line?: number) => void }) {
  const latest = d.claudeAudits[0];
  const jobs = useJobs();
  const job = (jobs.data ?? []).find((j) => j.kind === 'claude-audit' && j.targetId === d.skill.id);
  return (
    <div className="stack">
      {job && (job.state === 'running' || job.state === 'queued') ? <p className="notice">Claude is auditing this skill ({job.state}).</p> : null}
      {job?.state === 'failed' ? <ErrorBox error={new Error(`Claude audit failed: ${job.error}`)} /> : null}
      <section className="panel">
        <div className="panel-head">
          <h2>Claude audit</h2>
          {latest ? <span className="meta">{latest.model} · {ago(latest.at)}{latest.costUsd !== null ? ` · $${latest.costUsd.toFixed(4)}` : ''} · {(latest.durationMs / 1000).toFixed(0)} s</span> : null}
        </div>
        <div className="panel-body stack" style={{ gap: 12 }}>
          {latest ? (
            <>
              {latest.contentHash !== d.skill.contentHash ? <p className="notice"><strong>The files changed since this audit.</strong> Run it again for a current verdict.</p> : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <VerdictPill verdict={latest.combinedVerdict} />
                {latest.descriptionMatchesBehaviour ? <span className="tag">Matches its description</span> : <span className="pill dangerous">Does more than its description says</span>}
                {Object.entries(latest.capabilities).filter(([, v]) => v).map(([k]) => (
                  <span key={k} className="tag">Uses {k === 'fileWrites' ? 'file writes' : k}</span>
                ))}
              </div>
              <p>{latest.summary}</p>
              <FindingList findings={latest.findings} onOpenFile={onOpenFile} emptyText="Claude found nothing to report." />
            </>
          ) : (
            <Empty title="Not audited by Claude yet.">Use Audit with Claude above. It runs on your own claude CLI with the model and spend cap you choose.</Empty>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Static audit</h2>
          <span className="meta">{n(d.staticAudit.scannedFiles)} files · ruleset {d.staticAudit.ruleset}</span>
        </div>
        <div className="panel-body">
          <FindingList findings={d.staticAudit.findings} onOpenFile={onOpenFile} emptyText="The static rules found nothing." />
        </div>
      </section>
      <ScannersPanel d={d} onOpenFile={onOpenFile} />
      <p className="faint" style={{ fontSize: 12 }}>An audit lowers risk; it does not prove a skill is safe.</p>
    </div>
  );
}

function ScannersPanel({ d, onOpenFile }: { d: SkillDetail; onOpenFile: (file: string, line?: number) => void }) {
  const scanners = useQuery({ queryKey: ['scanners'], queryFn: api.scanners, staleTime: Infinity });
  const jobs = useJobs();
  const { run } = useAction();
  const running = (jobs.data ?? []).find((j) => j.kind === 'scanner' && j.targetId === d.skill.id && (j.state === 'running' || j.state === 'queued'));
  const failed = (jobs.data ?? []).find((j) => j.kind === 'scanner' && j.targetId === d.skill.id && j.state === 'failed');
  const list = scanners.data?.scanners ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>External scanners</h2>
        <span className="meta">Pinned versions, run through uvx on a copy of the skill</span>
      </div>
      <div className="panel-body stack" style={{ gap: 12 }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {list.map((s) => (
            <button key={s.id} className="btn btn-sm" disabled={!s.available || !!running} onClick={() => run(`scan-${s.id}`, () => api.runScanner(d.skill.id, s.id), `${s.label} started. The first run downloads it.`)}>
              Run {s.label}
            </button>
          ))}
          {list.length && !list[0]!.available ? <span className="muted">Install uv (docs.astral.sh/uv) to run these.</span> : null}
        </div>
        {running ? <p className="notice">{running.label} is running.</p> : null}
        {failed && !running ? <ErrorBox error={new Error(failed.error)} /> : null}
        {d.scanners.map((r) => (
          <div key={r.scanner} className="stack" style={{ gap: 6 }}>
            <h3 style={{ fontSize: 14 }}>
              {list.find((s) => s.id === r.scanner)?.label ?? r.scanner} <span className="muted" style={{ fontWeight: 400 }}>· {ago(r.at)}</span>
            </h3>
            {r.ok ? <FindingList findings={r.findings} onOpenFile={onOpenFile} emptyText="No findings." /> : <ErrorBox error={new Error(r.error)} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function FilesTab({ d, selected, onSelect, findingsFor }: { d: SkillDetail; selected: { path: string; line?: number } | null; onSelect: (f: { path: string } | null) => void; findingsFor: (path: string) => Set<number> }) {
  const content = useQuery({
    queryKey: ['skill-file', d.skill.id, selected?.path],
    queryFn: () => api.file(d.skill.id, selected!.path),
    enabled: !!selected,
  });
  return (
    <div className="grid grid-1-1" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
      <section className="panel">
        <div className="panel-body">
          <ul className="files">
            {d.files.map((f) => (
              <li key={f.path}>
                {f.kind === 'text' ? (
                  <button className="mono truncate" onClick={() => onSelect({ path: f.path })} aria-current={selected?.path === f.path}>
                    {f.path}
                  </button>
                ) : (
                  <span className="mono muted truncate">{f.path}</span>
                )}
                <span className="faint num">{f.kind === 'text' ? bytes(f.size) : f.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <div>
        {!selected ? <Empty title="Pick a file to read it." >Invisible characters show as red markers.</Empty> : null}
        {content.error ? <ErrorBox error={content.error} /> : null}
        {content.data ? <CodeView text={content.data.text} label={selected!.path} flagged={findingsFor(selected!.path)} /> : null}
      </div>
    </div>
  );
}

function HistoryTab({ d }: { d: SkillDetail }) {
  const { run, busy } = useAction();
  return (
    <div className="grid grid-1-1">
      <section className="panel">
        <div className="panel-head"><h2>Snapshots</h2><span className="meta">Saved before every update</span></div>
        <div className="panel-body">
          {d.snapshots.length ? (
            <ul className="timeline">
              {d.snapshots.map((snap) => (
                <li key={snap.id}>
                  <time>{date(snap.createdAt)}</time>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span>{snap.reason} <span className="mono faint">{snap.contentHash.slice(0, 10)}</span></span>
                    <button className="btn btn-sm" disabled={busy === snap.id} onClick={() => run(snap.id, () => api.restoreSnapshot(snap.id), 'Restored. The replaced version is in the trash.')}>
                      <Icon name="undo" size={14} /> Restore
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No snapshots yet.">Skillhangar saves one before it updates this skill.</Empty>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Usage</h2></div>
        <div className="panel-body">
          {d.usage ? (
            <dl className="kv">
              <dt>Times used</dt>
              <dd className="num">{n(d.usage.count)}</dd>
              <dt>Last used</dt>
              <dd>{ago(d.usage.lastUsed)}</dd>
            </dl>
          ) : (
            <Empty title="No usage recorded.">Turn on usage tracking in Settings to count each time Claude or you invoke a skill.</Empty>
          )}
        </div>
      </section>
    </div>
  );
}

function CopyDialog({ open, onClose, id, name }: { open: boolean; onClose: () => void; id: string; name: string }) {
  const [destination, setDestination] = useState<InstallDestination | null>(null);
  const [mode, setMode] = useState<'copy' | 'symlink'>('copy');
  const { run, busy } = useAction();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Copy ${name}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!destination || busy === 'copy' || (destination.kind === 'project' && !destination.path)}
            onClick={async () => {
              if (await run('copy', () => api.copy(id, destination!, mode), `Copied ${name}.`)) onClose();
            }}
          >
            Copy
          </button>
        </>
      }
    >
      <DestinationPicker value={destination} onChange={setDestination} mode={mode} onModeChange={setMode} />
    </Dialog>
  );
}

function TraceDialog({ open, onClose, id, name }: { open: boolean; onClose: () => void; id: string; name: string }) {
  const query = useQuery({ queryKey: ['trace', id], queryFn: () => api.trace(id), enabled: open, staleTime: 5 * 60_000, retry: false });
  const { run, busy } = useAction();
  const candidates: OriginCandidate[] = useMemo(() => query.data?.candidates ?? [], [query.data]);
  return (
    <Dialog open={open} onClose={onClose} title={`Where did ${name} come from?`} wide>
      <p className="muted">Searches skills.sh for skills with this name, then compares each one's SKILL.md with yours.</p>
      {query.isLoading ? <p className="muted">Searching…</p> : null}
      {query.error ? <ErrorBox error={query.error} /> : null}
      {query.data && !candidates.length ? <Empty title="No match found.">The skill may be private, renamed or written by hand.</Empty> : null}
      {candidates.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Path</th>
              <th className="num">Installs</th>
              <th>Match</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={`${c.owner}/${c.repo}/${c.skillPath}`}>
                <td>{c.owner}/{c.repo}</td>
                <td className="mono">{c.skillPath || '(root)'}</td>
                <td className="num">{c.installs !== null ? compact(c.installs) : '—'}</td>
                <td>
                  <span className={`pill ${c.match === 'exact' ? 'safe' : c.match === 'similar' ? 'caution' : ''}`}>{c.match === 'exact' ? 'Identical' : `${Math.round(c.similarity * 100)}% similar`}</span>
                </td>
                <td className="cell-actions">
                  <button
                    className="btn btn-sm"
                    disabled={busy === 'link' || c.match === 'different'}
                    onClick={async () => {
                      if (await run('link', () => api.linkOrigin(id, { owner: c.owner, repo: c.repo, skillPath: c.skillPath }), 'Origin recorded. Update checks now work for this skill.')) onClose();
                    }}
                  >
                    Use this origin
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Dialog>
  );
}
