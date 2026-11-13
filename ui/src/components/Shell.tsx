import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Icon, type IconName } from './icons';
import { Logo, type LogoState } from './Logo';
import { Dialog, useAction } from './ui';
import { api } from '../api';
import { keys, useJobs, useSettings, useSkillViews } from '../lib/data';
import { SCOPE_LABEL } from '../lib/format';

declare const __APP_VERSION__: string;

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  count?: number;
}

export function Shell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { skills, inventory, enrichment } = useSkillViews();
  const jobs = useJobs();
  const settings = useSettings();
  const client = useQueryClient();
  const { run, busy } = useAction();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);

  const running = (jobs.data ?? []).filter((j) => j.state === 'running' || j.state === 'queued');
  const [logoState, setLogoState] = useState<LogoState>('idle');
  const wasBusy = useRef(false);
  useEffect(() => {
    const auditing = running.some((j) => j.kind === 'claude-audit');
    if (running.length) setLogoState(auditing ? 'auditing' : 'scanning');
    else if (wasBusy.current) setLogoState('settled');
    wasBusy.current = running.length > 0;
  }, [running.length, running.some((j) => j.kind === 'claude-audit')]);

  useEffect(() => setNavOpen(false), [location]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Theme: system by default; an explicit choice is stored in Skillhangar's settings.
  useEffect(() => {
    const theme = settings.data?.theme ?? 'system';
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [settings.data?.theme]);

  const counts = useMemo(() => {
    const live = skills.filter((s) => s.scope !== 'agents-store');
    return {
      skills: live.length,
      review: live.filter((s) => s.needsReview).length,
      updates: live.filter((s) => s.update?.state === 'available').length,
    };
  }, [skills]);

  const nav: NavItem[] = [
    { href: '/', label: 'Overview', icon: 'overview' },
    { href: '/library', label: 'Skills', icon: 'library', count: counts.skills },
    { href: '/mcp', label: 'MCP servers', icon: 'mcp', count: inventory?.mcp.filter((m) => m.scope !== 'connector').length },
    { href: '/plugins', label: 'Plugins', icon: 'plugins', count: inventory?.plugins.length },
    { href: '/audits', label: 'Audits', icon: 'audits', count: counts.review || undefined },
    { href: '/updates', label: 'Updates', icon: 'updates', count: enrichment?.enabled ? counts.updates || undefined : undefined },
    { href: '/add', label: 'Add a skill', icon: 'add' },
  ];
  const manage: NavItem[] = [
    { href: '/activity', label: 'Activity', icon: 'activity' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ];
  const isCurrent = (href: string) => (href === '/' ? location === '/' : location.startsWith(href) || (href === '/library' && location.startsWith('/skills')));

  const link = (item: NavItem) => (
    <a key={item.href} href={`#${item.href}`} className="nav-link" aria-current={isCurrent(item.href) ? 'page' : undefined}>
      <Icon name={item.icon} />
      {item.label}
      {item.count !== undefined ? <span className="count">{item.count}</span> : null}
    </a>
  );

  const theme = settings.data?.theme ?? 'system';
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <nav className="sidebar" aria-label="Main">
        <a href="#/" className="brand">
          <Logo state={logoState} size={22} />
          <span>
            Skillhangar <small>for Claude Code</small>
          </span>
        </a>
        {nav.map(link)}
        <div className="nav-group">Manage</div>
        {manage.map(link)}
        <div className="sidebar-foot">
          <button
            className="btn btn-ghost btn-sm"
            style={{ justifySelf: 'start' }}
            onClick={() => run('theme', async () => client.setQueryData(keys.settings, await api.saveSettings({ theme: nextTheme })))}
            aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
          >
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            {theme === 'system' ? 'System theme' : theme === 'light' ? 'Light theme' : 'Dark theme'}
          </button>
          <span>Unofficial. Not affiliated with Anthropic.</span>
          <span>v{typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}</span>
        </div>
      </nav>
      {navOpen ? <div className="nav-scrim" onClick={() => setNavOpen(false)} /> : null}

      <header className="topbar">
        <div>
          <button className="btn btn-ghost btn-icon menu-button" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <Icon name="menu" />
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>
          <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
            <span className="truncate">Search skills, servers and screens</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
        <div className="topbar-right">
          {running.length ? (
            <button className="jobs-chip" onClick={() => setJobsOpen(true)}>
              <Logo size={14} state={logoState} />
              {running.length} running
            </button>
          ) : null}
          <button
            className="btn btn-ghost btn-icon"
            aria-label="Rescan"
            title="Rescan skills and servers"
            disabled={busy === 'rescan'}
            onClick={() => run('rescan', async () => client.setQueryData(keys.inventory, await api.inventory(true)), 'Rescanned')}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>

      <main className="sheet" id="main">
        {children}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onGo={(href) => navigate(href)} />
      <Dialog open={jobsOpen} onClose={() => setJobsOpen(false)} title="Background work">
        {(jobs.data ?? []).length === 0 ? <p className="muted">Nothing is running.</p> : null}
        <ul>
          {(jobs.data ?? []).slice(0, 12).map((job) => (
            <li key={job.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate">{job.label}</div>
                <div className="cell-sub">
                  {job.state}
                  {job.progress ? ` · ${job.progress.done} of ${job.progress.total}` : ''}
                  {job.error ? ` · ${job.error}` : ''}
                </div>
              </div>
              {job.state === 'running' || job.state === 'queued' ? (
                <button className="btn btn-sm" onClick={() => run('cancel', () => api.cancelJob(job.id))}>
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function CommandPalette({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: (href: string) => void }) {
  const { skills, inventory } = useSkillViews();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setQuery('');
      setIndex(0);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const items = useMemo(() => {
    const screens = [
      ['Overview', '/'], ['Skills', '/library'], ['MCP servers', '/mcp'], ['Plugins', '/plugins'], ['Audits', '/audits'],
      ['Updates', '/updates'], ['Add a skill', '/add'], ['Activity', '/activity'], ['Settings', '/settings'],
    ].map(([label, href]) => ({ label: label!, href: href!, kind: 'Screen' }));
    const skillItems = skills
      .filter((s) => !s.shadowedBy)
      .map((s) => ({ label: s.name, href: `/skills/${s.id}`, kind: `${SCOPE_LABEL[s.scope]} skill` }));
    const servers = (inventory?.mcp ?? []).map((m) => ({ label: m.name, href: '/mcp', kind: `MCP ${m.scope}` }));
    const all = [...screens, ...skillItems, ...servers];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 40);
    return all
      .map((item) => ({ item, at: item.label.toLowerCase().indexOf(q) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at || a.item.label.length - b.item.label.length)
      .slice(0, 40)
      .map((x) => x.item);
  }, [skills, inventory, query]);

  const go = (href: string) => {
    onClose();
    onGo(href);
  };

  return (
    <dialog ref={ref} className="palette" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Search">
      {open ? (
        <>
          <input
            autoFocus
            value={query}
            placeholder="Jump to a skill, server or screen"
            aria-label="Search"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && items[index]) {
                go(items[index]!.href);
              }
            }}
          />
          <ul role="listbox">
            {items.map((item, i) => (
              <li key={`${item.kind}-${item.href}`}>
                <button role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => go(item.href)}>
                  <span className="truncate">{item.label}</span>
                  <span className="kind">{item.kind}</span>
                </button>
              </li>
            ))}
            {!items.length ? <li className="muted" style={{ padding: '10px 12px' }}>No match.</li> : null}
          </ul>
        </>
      ) : null}
    </dialog>
  );
}
