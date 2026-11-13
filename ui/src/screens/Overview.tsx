import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api';
import { AuditDialog } from '../components/AuditDialog';
import { Empty, ErrorBox, TitleRow, useAction, useToast } from '../components/ui';
import { useSkillViews, type SkillView } from '../lib/data';
import { ago, compact, date, n, plural, SCOPE_LABEL, tildify } from '../lib/format';
import type { Inventory } from '@shared/types';

type FloorScope = 'everywhere' | 'projects' | 'all';

function bayClass(s: SkillView): string {
  const reviewed = !!s.review && !s.review.changedSince;
  if (s.shadowedBy) return 'bay shadowed';
  if (!s.audit) return 'bay pending';
  if (reviewed && s.verdict !== 'safe') return 'bay reviewed';
  if (s.verdict === 'dangerous') return 'bay dangerous';
  if (s.verdict === 'caution') return 'bay caution';
  return 'bay safe';
}

function groupOf(s: SkillView): string {
  if (s.scope === 'plugin') return `Plugin ${s.pluginId?.split('@')[0] ?? ''}`;
  if (s.provenance?.github) return `${s.provenance.github.owner}/${s.provenance.github.repo}`;
  if (s.scope === 'project') return `${s.projectPath?.split('/').pop() ?? 'Project'}, origin unknown`;
  return `${SCOPE_LABEL[s.scope]}, origin unknown`;
}

const EVERYWHERE = new Set(['personal', 'managed', 'synced', 'plugin', 'legacy-command']);

interface AttentionItem {
  severity: 'critical' | 'high' | 'medium';
  what: string;
  why: string;
  href: string;
}

function attentionItems(skills: SkillView[], inventory: Inventory): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of skills) {
    if (!s.needsReview) continue;
    const counts = s.audit?.counts;
    items.push({
      severity: s.verdict === 'dangerous' ? 'critical' : 'high',
      what: `${s.name} ${s.verdict === 'dangerous' ? 'looks dangerous' : 'needs review'}`,
      why: counts ? `${plural(counts.critical, 'critical finding')}, ${plural(counts.high, 'high finding')}` : 'Flagged by the audit',
      href: `#/skills/${s.id}`,
    });
  }
  for (const m of inventory.mcp) {
    if (m.scope === 'connector') continue;
    const worst = m.health.find((h) => h.severity === 'high') ?? m.health.find((h) => h.severity === 'medium');
    if (worst) items.push({ severity: worst.severity === 'high' ? 'high' : 'medium', what: `MCP server ${m.name}`, why: worst.message, href: '#/mcp' });
    if (m.auth.state === 'needs-auth') items.push({ severity: 'medium', what: `${m.name} needs sign-in`, why: 'Run /mcp in Claude Code to authenticate.', href: '#/mcp' });
  }
  for (const s of skills) {
    const broken = s.health.find((h) => h.severity === 'high' && h.code !== 'shadowed');
    if (broken && !s.shadowedBy) items.push({ severity: 'high', what: s.name, why: broken.message, href: `#/skills/${s.id}` });
  }
  const order = { critical: 0, high: 1, medium: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function Overview() {
  const { skills, inventory, enrichment, isLoading, error } = useSkillViews();
  const [floorScope, setFloorScope] = useState<FloorScope>('everywhere');
  const [auditOpen, setAuditOpen] = useState(false);
  const [, navigate] = useLocation();
  const { run } = useAction();
  const toast = useToast();

  const live = useMemo(() => skills.filter((s) => s.scope !== 'agents-store'), [skills]);
  const needsReview = useMemo(() => live.filter((s) => s.needsReview), [live]);
  const dangerous = needsReview.filter((s) => s.verdict === 'dangerous').length;
  const updates = live.filter((s) => s.update?.state === 'available');
  const pendingAudits = live.filter((s) => !s.audit && s.contentHash).length;

  const floor = useMemo(() => {
    const visible = live.filter((s) => (floorScope === 'all' ? true : floorScope === 'everywhere' ? EVERYWHERE.has(s.scope) : s.scope === 'project'));
    const groups = new Map<string, SkillView[]>();
    for (const s of visible) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s]);
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [live, floorScope]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (isLoading || !inventory) return <OverviewSkeleton />;

  const attention = attentionItems(live, inventory);
  const configured = inventory.mcp.filter((m) => m.scope !== 'connector');
  const mcpNeedsAuth = configured.filter((m) => m.auth.state === 'needs-auth').length;
  const mcpIssues = inventory.mcp.filter((m) => m.health.some((h) => h.severity === 'high' || h.severity === 'medium')).length;
  const recent = [...live].filter((s) => s.installedAt && !s.shadowedBy).sort((a, b) => b.installedAt!.localeCompare(a.installedAt!)).slice(0, 6);
  const costly = [...live].filter((s) => EVERYWHERE.has(s.scope) && !s.shadowedBy && s.override !== 'off').sort((a, b) => b.contextChars - a.contextChars).slice(0, 6);
  const maxCost = costly[0]?.contextChars ?? 1;

  const findingParts: string[] = [];
  if (needsReview.length) findingParts.push(`${plural(needsReview.length, 'skill')} ${needsReview.length === 1 ? 'needs' : 'need'} review${dangerous ? `, ${n(dangerous)} flagged dangerous` : ''}`);
  if (updates.length) findingParts.push(`${plural(updates.length, 'update')} available`);
  if (mcpIssues) findingParts.push(`${plural(mcpIssues, 'MCP server')} with config issues`);

  const startAudits = async (options: { model: string; budgetUsd: number; maxTurns: number }) => {
    setAuditOpen(false);
    let started = 0;
    for (const s of needsReview) {
      const job = await run(`audit-${s.id}`, () => api.audit(s.id, options));
      if (job) started++;
    }
    if (started) toast(`Started ${plural(started, 'Claude audit')}. Two run at a time.`, { action: { label: 'View', run: () => navigate('/audits') } });
  };

  return (
    <div className="page">
      <TitleRow
        title="Overview"
        lede={findingParts.length ? <><strong>{findingParts[0]}.</strong> {findingParts.slice(1).join('. ')}{findingParts.length > 1 ? '.' : ''}</> : pendingAudits ? `Auditing ${plural(pendingAudits, 'skill')} in the background.` : 'Nothing needs your attention.'}
        actions={
          <>
            <span className="stamp">Scanned {ago(inventory.generatedAt)} in {n(inventory.durationMs)} ms</span>
            {needsReview.length ? (
              <button className="btn btn-primary" onClick={() => setAuditOpen(true)}>
                Audit what needs review
              </button>
            ) : (
              <a className="btn btn-primary" href="#/add">
                Add a skill
              </a>
            )}
          </>
        }
      />

      <div className="kpis" style={{ ['--n' as string]: 5 }}>
        <a className="kpi" href="#/library">
          <div className="kpi-label">Skills listed to Claude</div>
          <div className="kpi-value lead num">{n(inventory.context.listed)}</div>
          <div className="kpi-sub">{n(live.length)} installed in all scopes</div>
        </a>
        <a className="kpi" href="#/audits">
          <div className="kpi-label">Need review</div>
          <div className="kpi-value num">{n(needsReview.length)}</div>
          <div className="kpi-sub">{dangerous ? <span className="bad">{n(dangerous)} dangerous</span> : pendingAudits ? `${n(pendingAudits)} still auditing` : 'Static audit of every skill'}</div>
        </a>
        <a className="kpi" href="#/updates">
          <div className="kpi-label">Updates available</div>
          <div className="kpi-value num">{enrichment?.enabled ? n(updates.length) : '—'}</div>
          <div className="kpi-sub">{enrichment?.enabled ? (enrichment.fetchedAt ? `Checked ${ago(enrichment.fetchedAt)}` : 'Not checked yet') : 'Network lookups are off'}</div>
        </a>
        <a className="kpi" href="#/mcp">
          <div className="kpi-label">MCP servers</div>
          <div className="kpi-value num">{n(configured.length)}</div>
          <div className="kpi-sub">{mcpNeedsAuth ? `${n(mcpNeedsAuth)} need sign-in` : `${n(mcpIssues)} with config issues`}</div>
        </a>
        <div className="kpi">
          <div className="kpi-label">Skill listing per session</div>
          <div className="kpi-value num">{compact(inventory.context.totalChars)}</div>
          <div className="kpi-sub">characters before you type</div>
        </div>
      </div>

      <div className="grid grid-2-1">
        <section className="panel" aria-labelledby="floor-title">
          <div className="panel-head">
            <h2 id="floor-title">Hangar floor</h2>
            <div className="seg" role="group" aria-label="Which skills">
              {(['everywhere', 'projects', 'all'] as const).map((scope) => (
                <button key={scope} aria-pressed={floorScope === scope} onClick={() => setFloorScope(scope)}>
                  {scope === 'everywhere' ? 'Every session' : scope === 'projects' ? 'Projects' : 'All'}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body">
            <div className="legend" style={{ marginBottom: 16 }}>
              <span><i className="bay safe" /> No issues</span>
              <span><i className="bay caution" /> Needs review</span>
              <span><i className="bay dangerous" /> Dangerous</span>
              <span><i className="bay reviewed" /> Reviewed by you</span>
              <span><i className="bay pending" /> Auditing</span>
              <span><i className="bay shadowed" /> Shadowed</span>
            </div>
            {floor.length ? (
              <div className="floor">
                {floor.map(([group, bays]) => (
                  <div className="floor-group" key={group}>
                    <div className="floor-group-name">
                      <b className="truncate" title={group}>{group}</b>
                      {plural(bays.length, 'skill')}
                    </div>
                    <div className="bays">
                      {bays.map((s) => (
                        <a key={s.id} href={`#/skills/${s.id}`} className={bayClass(s)} title={`${s.name}: ${s.shadowedBy ? 'shadowed' : s.verdict}`} aria-label={`${s.name}, ${s.verdict}`} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No skills in this view." />
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="attention-title">
          <div className="panel-head">
            <h2 id="attention-title">Needs attention</h2>
            <span className="meta">{n(attention.length)}</span>
          </div>
          <div className="panel-body">
            {attention.length ? (
              <ul className="attention">
                {attention.slice(0, 7).map((item, i) => (
                  <li key={i}>
                    <span className={`sev ${item.severity}`} />
                    <div style={{ minWidth: 0 }}>
                      <div className="what truncate">{item.what}</div>
                      <div className="why">{item.why}</div>
                    </div>
                    <a className="btn btn-sm" href={item.href}>
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing to fix.">Every skill passed its audit and every server is configured.</Empty>
            )}
            {attention.length > 7 ? (
              <a className="link" href="#/audits" style={{ display: 'inline-block', marginTop: 12 }}>
                View all {n(attention.length)}
              </a>
            ) : null}
          </div>
        </section>
      </div>

      <div className="grid grid-1-1 section-gap">
        <section className="panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <h2 id="recent-title">Recently installed</h2>
            <a className="link" href="#/library">View all</a>
          </div>
          <div className="panel-body">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Source</th>
                  <th className="num">Installed</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/skills/${s.id}`)}>
                    <td>
                      <a href={`#/skills/${s.id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>
                        {s.name}
                      </a>
                    </td>
                    <td className="secondary truncate" style={{ maxWidth: 220 }}>{s.provenance?.source ?? <span className="faint">Unknown</span>}</td>
                    <td className="num">{date(s.installedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel" aria-labelledby="cost-title">
          <div className="panel-head">
            <h2 id="cost-title">Largest skill listings</h2>
            <span className="meta">characters per session</span>
          </div>
          <div className="panel-body">
            <ul className="barlist">
              {costly.map((s) => (
                <li key={s.id}>
                  <div className="row">
                    <a href={`#/skills/${s.id}`} className="truncate">{s.name}</a>
                    <span className="num muted">{n(s.contextChars)}</span>
                  </div>
                  <div className="track"><div className="fill" style={{ width: `${(s.contextChars / maxCost) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
            <p className="faint" style={{ marginTop: 8, fontSize: 12 }}>
              Claude reads each listed skill's name and description, up to {n(inventory.context.perSkillCap)} characters, at the start of every session in{' '}
              {tildify(inventory.profiles.find((p) => p.isActive)?.configDir)}.
            </p>
          </div>
        </section>
      </div>

      <AuditDialog open={auditOpen} onClose={() => setAuditOpen(false)} onStart={startAudits} subject="flagged skills" count={needsReview.length} />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <TitleRow title="Overview" lede={<span className="skeleton" style={{ width: 280 }} />} />
      <div className="kpis" style={{ ['--n' as string]: 5 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <div className="kpi" key={i}>
            <div className="kpi-label"><span className="skeleton" style={{ width: 110 }} /></div>
            <div className="kpi-value"><span className="skeleton" style={{ width: 48, height: 24 }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
