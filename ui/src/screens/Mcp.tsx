import { useMemo, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/icons';
import { Dialog, Empty, ErrorBox, TitleRow, useAction, useToast } from '../components/ui';
import { useEnrichment, useInventory, useJobs } from '../lib/data';
import { ago, n, plural, tildify } from '../lib/format';
import type { McpAuthState, McpServerRecord } from '@shared/types';

const AUTH: Record<McpAuthState, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'safe' },
  'needs-auth': { label: 'Needs sign-in', tone: 'caution' },
  failed: { label: 'Failed', tone: 'dangerous' },
  pending: { label: 'Starting', tone: '' },
  unknown: { label: 'Not checked', tone: 'outline' },
  'not-required': { label: 'Local process', tone: 'outline' },
};

export function McpScreen() {
  const inventory = useInventory();
  const enrichment = useEnrichment();
  const jobs = useJobs();
  const { run, busy } = useAction();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServerRecord | null>(null);

  const servers = useMemo(() => (inventory.data?.mcp ?? []).filter((m) => m.scope !== 'connector').sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)), [inventory.data]);
  const connectors = useMemo(() => (inventory.data?.mcp ?? []).filter((m) => m.scope === 'connector').sort((a, b) => a.name.localeCompare(b.name)), [inventory.data]);
  if (inventory.error) return <div className="page"><ErrorBox error={inventory.error} /></div>;
  const active = inventory.data?.profiles.find((p) => p.isActive) ?? inventory.data?.profiles[0];
  const probing = (jobs.data ?? []).some((j) => j.kind === 'mcp-probe' && (j.state === 'running' || j.state === 'queued'));
  const plaintext = servers.filter((s) => s.env.some((e) => e.plaintextSecret) || s.headers.some((h) => h.plaintextSecret)).length;
  const unpinned = servers.filter((s) => s.package && !s.package.pinned).length;
  const needsAuth = servers.filter((s) => s.auth.state === 'needs-auth').length;

  const lede = [
    needsAuth ? `${plural(needsAuth, 'server')} ${needsAuth === 1 ? 'needs' : 'need'} sign-in` : null,
    plaintext ? `${plural(plaintext, 'server')} ${plaintext === 1 ? 'stores' : 'store'} a key in plain text` : null,
    unpinned ? `${plural(unpinned, 'server')} ${unpinned === 1 ? 'runs' : 'run'} an unpinned package` : null,
  ].filter(Boolean);

  return (
    <div className="page">
      <TitleRow
        title="MCP servers"
        lede={lede.length ? <><strong>{lede[0]}.</strong> {lede.slice(1).join('. ')}{lede.length > 1 ? '.' : ''}</> : 'Every MCP server Claude Code can start, by scope. Values of keys and headers never leave this machine or this server.'}
        actions={
          <>
            <button
              className="btn"
              disabled={!active || probing}
              onClick={() => run('probe', () => api.probe(active!.id), 'Checking connections. Claude Code starts each server once.')}
            >
              {probing ? 'Checking…' : 'Check connections'}
            </button>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add server
            </button>
          </>
        }
      />
      {servers.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Server</th>
                <th>Scope</th>
                <th>Package</th>
                <th>Connection</th>
                <th>Issues</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const pkgKey = s.package ? `${s.package.ecosystem}:${s.package.name}` : null;
                const pkg = pkgKey ? enrichment.data?.packages[pkgKey] : undefined;
                const auth = AUTH[s.auth.state];
                const issue = s.health.find((h) => h.severity === 'high') ?? s.health.find((h) => h.severity === 'medium') ?? s.health[0];
                return (
                  <tr key={s.id}>
                    <td style={{ maxWidth: 0, width: '30%' }}>
                      <div className="cell-title">{s.name}</div>
                      <div className="cell-sub mono truncate">{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</div>
                    </td>
                    <td className="secondary">
                      {s.scope === 'connector' ? 'claude.ai' : s.scope}
                      {s.projectPath ? <div className="cell-sub truncate" style={{ maxWidth: 180 }}>{tildify(s.projectPath)}</div> : null}
                      {s.pluginId ? <div className="cell-sub">{s.pluginId}</div> : null}
                    </td>
                    <td className="hide-phone">
                      {s.package ? (
                        <>
                          <span className="mono">{s.package.name}</span>
                          <div className="cell-sub">
                            {s.package.pinned ? s.package.version : <span className="sev-label medium">unpinned</span>}
                            {pkg?.latest ? ` · latest ${pkg.latest}` : ''}
                            {pkg?.vulns.length ? <span className="sev-label critical"> · {plural(pkg.vulns.length, 'known vulnerability', 'known vulnerabilities')}</span> : null}
                          </div>
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${auth.tone}`}>{auth.label}</span>
                      {s.auth.source === 'probe' && s.auth.checkedAt ? <div className="cell-sub">{ago(s.auth.checkedAt)}</div> : null}
                    </td>
                    <td className="hide-phone" style={{ maxWidth: 280 }}>
                      {issue ? (
                        <span className={`sev-label ${issue.severity}`} style={{ textTransform: 'none', fontWeight: 500 }}>
                          {issue.message}
                        </span>
                      ) : (
                        <span className="faint">None</span>
                      )}
                      {s.health.length > 1 ? <div className="cell-sub">and {n(s.health.length - 1)} more</div> : null}
                    </td>
                    <td className="cell-actions">
                      {(s.scope === 'local' || s.scope === 'project') && s.projectPath && active ? (
                        <button className="btn btn-sm" disabled={probing} onClick={() => run(`probe-${s.id}`, () => api.probe(active.id, s.projectPath), 'Checking this project’s servers.')}>
                          Check
                        </button>
                      ) : null}
                      {s.scope !== 'managed' && s.scope !== 'plugin' && s.scope !== 'connector' ? (
                        <button className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${s.name}`} onClick={() => setRemoving(s)}>
                          <Icon name="trash" size={14} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No MCP servers configured." />
      )}
      {connectors.length ? (
        <section className="section-gap" aria-labelledby="connectors-title" style={{ marginTop: 32 }}>
          <div className="title-row" style={{ marginBottom: 12 }}>
            <div>
              <h2 id="connectors-title" style={{ fontSize: 16, fontWeight: 600 }}>claude.ai connectors</h2>
              <p className="lede">
                {plural(connectors.filter((c) => c.auth.state === 'connected').length, 'connector')} connected. The rest are available on your account but not signed in; turn them on in claude.ai settings if you want them.
              </p>
            </div>
          </div>
          <table className="table responsive">
            <thead>
              <tr>
                <th>Connector</th>
                <th>Address</th>
                <th>Connection</th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((c) => (
                <tr key={c.id}>
                  <td className="cell-title">{c.name.replace(/^claude\.ai /, '')}</td>
                  <td className="secondary mono truncate" style={{ maxWidth: 360 }}>{c.host ?? c.url ?? '—'}</td>
                  <td>
                    <span className={`pill ${AUTH[c.auth.state].tone}`}>{c.auth.state === 'needs-auth' ? 'Not signed in' : AUTH[c.auth.state].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <p className="faint" style={{ fontSize: 12, marginTop: 16 }}>
        Changes go through the claude CLI (claude mcp add-json and claude mcp remove), which owns .claude.json. Check connections starts a headless Claude Code session in the folder, reads each server's
        status as it starts, and stops it.
      </p>

      <AddServerDialog open={adding} onClose={() => setAdding(false)} />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        footer={
          <>
            <button className="btn" onClick={() => setRemoving(null)}>Keep it</button>
            <button
              className="btn btn-danger"
              disabled={busy === 'remove'}
              onClick={async () => {
                if (removing && (await run('remove', () => api.removeMcp(removing.id)))) {
                  toast(`${removing.name} removed from ${removing.scope} scope.`);
                  setRemoving(null);
                }
              }}
            >
              Remove server
            </button>
          </>
        }
      >
        <p>
          This runs <span className="mono">claude mcp remove {removing?.name} --scope {removing?.scope}</span>. Its key values are deleted with it and are not kept by Skillhangar, so note them
          first if you will add it again.
        </p>
      </Dialog>
    </div>
  );
}

function AddServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const inventory = useInventory();
  const { run, busy } = useAction();
  const profiles = inventory.data?.profiles ?? [];
  const projects = inventory.data?.projects ?? [];
  const [name, setName] = useState('');
  const [profileId, setProfileId] = useState('');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [projectPath, setProjectPath] = useState('');
  const [config, setConfig] = useState('{\n  "type": "http",\n  "url": "https://mcp.context7.com/mcp"\n}');

  let parsed: Record<string, unknown> | null = null;
  let parseError = '';
  try {
    const value = JSON.parse(config) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    else parseError = 'The config must be a JSON object.';
  } catch (e) {
    parseError = (e as Error).message;
  }
  const chosenProfile = profileId || profiles.find((p) => p.isActive)?.id || profiles[0]?.id || '';
  const valid = /^[\w.-]{1,64}$/.test(name) && !!parsed && (scope === 'user' || !!projectPath);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an MCP server"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!valid || busy === 'add'}
            onClick={async () => {
              if (await run('add', () => api.addMcp({ profileId: chosenProfile, name, scope, projectPath: scope === 'user' ? undefined : projectPath, config: parsed! }), `${name} added.`)) onClose();
            }}
          >
            Add server
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" aria-describedby="name-hint" />
        <span className="hint" id="name-hint">Letters, digits, dot, dash and underscore.</span>
      </label>
      <div className="grid grid-1-1">
        <label className="field">
          <span>Profile</span>
          <select className="select" value={chosenProfile} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.isActive ? ' (active)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scope</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="user">User: every project</option>
            <option value="project">Project: shared in .mcp.json</option>
            <option value="local">Local: this project, only you</option>
          </select>
        </label>
      </div>
      {scope !== 'user' ? (
        <label className="field">
          <span>Project</span>
          <select className="select" value={projectPath} onChange={(e) => setProjectPath(e.target.value)}>
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p} value={p}>{tildify(p)}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        <span>Config (JSON)</span>
        <textarea className="input" rows={7} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} aria-describedby="config-hint" />
        <span className="hint" id="config-hint">
          {parseError ? <span className="sev-label critical" style={{ textTransform: 'none' }}>{parseError}</span> : 'stdio: {"command": "npx", "args": ["-y", "pkg@1.2.3"]}. Reference secrets as ${ENV_VAR} instead of pasting them.'}
        </span>
      </label>
    </Dialog>
  );
}
