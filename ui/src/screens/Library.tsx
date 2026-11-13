import { useDeferredValue, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { Empty, ErrorBox, Tabs, TitleRow, VerdictPill } from '../components/ui';
import { useSkillViews, type SkillView } from '../lib/data';
import { compact, date, n, SCOPE_LABEL } from '../lib/format';

type TabId = 'loaded' | 'personal' | 'project' | 'plugin' | 'other';
type VerdictFilter = 'any' | 'review' | 'dangerous' | 'unaudited' | 'clean';
type Sort = 'name' | 'installed' | 'stars' | 'context';

const PAGE = 150;

function inTab(s: SkillView, tab: TabId): boolean {
  switch (tab) {
    case 'loaded':
      return !s.shadowedBy && s.scope !== 'agents-store';
    case 'personal':
      return s.scope === 'personal' || s.scope === 'managed';
    case 'project':
      return s.scope === 'project';
    case 'plugin':
      return s.scope === 'plugin';
    case 'other':
      return s.scope === 'synced' || s.scope === 'legacy-command' || s.scope === 'agents-store';
  }
}

export function Library() {
  const { skills, isLoading, error, enrichment } = useSkillViews();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<TabId>('loaded');
  const [query, setQuery] = useState('');
  const [verdict, setVerdict] = useState<VerdictFilter>('any');
  const [origin, setOrigin] = useState<'any' | 'known' | 'unknown'>('any');
  const [onlyUpdates, setOnlyUpdates] = useState(false);
  const [sort, setSort] = useState<Sort>('name');
  const [limit, setLimit] = useState(PAGE);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const counts = useMemo(() => {
    const out: Record<TabId, number> = { loaded: 0, personal: 0, project: 0, plugin: 0, other: 0 };
    for (const s of skills) for (const t of Object.keys(out) as TabId[]) if (inTab(s, t)) out[t]++;
    return out;
  }, [skills]);

  const rows = useMemo(() => {
    const filtered = skills.filter((s) => {
      if (!inTab(s, tab)) return false;
      if (deferredQuery && !`${s.name} ${s.description} ${s.provenance?.source ?? ''}`.toLowerCase().includes(deferredQuery)) return false;
      if (verdict === 'review' && !s.needsReview) return false;
      if (verdict === 'dangerous' && s.verdict !== 'dangerous') return false;
      if (verdict === 'unaudited' && s.audit) return false;
      if (verdict === 'clean' && s.verdict !== 'safe') return false;
      if (origin === 'known' && !s.provenance) return false;
      if (origin === 'unknown' && s.provenance) return false;
      if (onlyUpdates && s.update?.state !== 'available') return false;
      return true;
    });
    const by: Record<Sort, (a: SkillView, b: SkillView) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      installed: (a, b) => (b.installedAt ?? '').localeCompare(a.installedAt ?? ''),
      stars: (a, b) => (b.repo?.stars ?? -1) - (a.repo?.stars ?? -1),
      context: (a, b) => b.contextChars - a.contextChars,
    };
    return filtered.sort(by[sort]);
  }, [skills, tab, deferredQuery, verdict, origin, onlyUpdates, sort]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;

  return (
    <div className="page">
      <TitleRow
        title="Skills"
        lede="Every skill Claude Code can load on this machine, where it came from, and what the audit found."
        actions={<a className="btn btn-primary" href="#/add">Add a skill</a>}
      />
      <Tabs
        label="Scope"
        value={tab}
        onChange={(t) => {
          setTab(t);
          setLimit(PAGE);
        }}
        tabs={[
          { id: 'loaded', label: 'Loaded', count: counts.loaded },
          { id: 'personal', label: 'Personal', count: counts.personal },
          { id: 'project', label: 'Project', count: counts.project },
          { id: 'plugin', label: 'Plugin', count: counts.plugin },
          { id: 'other', label: 'Other', count: counts.other },
        ]}
      />
      <div className="toolbar">
        <input className="input" style={{ width: 280 }} type="search" placeholder="Search names, descriptions, sources" aria-label="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="select" aria-label="Audit" value={verdict} onChange={(e) => setVerdict(e.target.value as VerdictFilter)}>
          <option value="any">Any audit result</option>
          <option value="review">Needs review</option>
          <option value="dangerous">Dangerous</option>
          <option value="clean">No issues</option>
          <option value="unaudited">Not audited yet</option>
        </select>
        <select className="select" aria-label="Origin" value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
          <option value="any">Any origin</option>
          <option value="known">Known source</option>
          <option value="unknown">Unknown source</option>
        </select>
        {enrichment?.enabled ? (
          <label className="check" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={onlyUpdates} onChange={(e) => setOnlyUpdates(e.target.checked)} />
            Updates only
          </label>
        ) : null}
        <span className="grow" />
        <span className="count num">{n(rows.length)} shown</span>
        <select className="select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="name">Sort by name</option>
          <option value="installed">Newest first</option>
          <option value="stars">Most stars</option>
          <option value="context">Largest listing</option>
        </select>
      </div>

      {isLoading ? (
        <p className="muted">Scanning…</p>
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Skill</th>
                <th>Source</th>
                <th>Scope</th>
                <th className="num">Installed</th>
                <th className="num">Stars</th>
                <th>Audit</th>
                <th>Update</th>
                <th className="num">Listing</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/skills/${s.id}`)}>
                  <td style={{ maxWidth: 0 }}>
                    <a href={`#/skills/${s.id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </a>
                    <div className="cell-sub truncate">{s.description || '—'}</div>
                  </td>
                  <td className="secondary truncate" style={{ maxWidth: 200 }}>
                    {s.provenance ? s.provenance.source : <span className="faint">Unknown</span>}
                  </td>
                  <td className="hide-phone">
                    {SCOPE_LABEL[s.scope]}
                    {s.projectPath && s.scope === 'project' ? <div className="cell-sub truncate" style={{ maxWidth: 140 }}>{s.projectPath.split('/').pop()}</div> : null}
                    {s.shadowedBy ? <div className="cell-sub">Shadowed</div> : null}
                  </td>
                  <td className="num hide-phone">{date(s.installedAt)}</td>
                  <td className="num hide-phone">{s.repo ? compact(s.repo.stars) : '—'}</td>
                  <td>
                    <VerdictPill verdict={s.verdict} reviewed={!!s.review && !s.review.changedSince} />
                  </td>
                  <td className="hide-phone">
                    {s.update?.state === 'available' ? <span className="pill caution">Available</span> : s.update?.state === 'up-to-date' ? <span className="muted">Current</span> : <span className="faint">—</span>}
                  </td>
                  <td className="num hide-phone">{s.override === 'off' ? <span className="faint">Off</span> : n(s.contextChars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit ? (
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setLimit((l) => l + PAGE)}>
              Show {n(Math.min(PAGE, rows.length - limit))} more of {n(rows.length - limit)}
            </button>
          ) : null}
        </div>
      ) : (
        <Empty title="No skill matches these filters.">Clear the search or pick another tab.</Empty>
      )}
    </div>
  );
}
