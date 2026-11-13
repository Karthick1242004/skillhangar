import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorBox, TitleRow, useAction } from '../components/ui';
import { keys, useEnrichment, useInventory, useJobs, useSettings } from '../lib/data';
import { ago, date, n, tildify } from '../lib/format';
import { MODEL_CHOICES } from '@shared/types';

const ENDPOINTS = [
  'api.github.com (stars, licence, last push, update checks; uses your gh login when present)',
  'codeload.github.com (downloads of an exact commit)',
  'raw.githubusercontent.com (GitHub Trending archive, origin tracing)',
  'skills.sh (install counts and partner audit verdicts)',
  'api.scorecard.dev (OpenSSF Scorecard)',
  'registry.npmjs.org, pypi.org, api.osv.dev (MCP package versions and known vulnerabilities)',
];

export function SettingsScreen() {
  const settings = useSettings();
  const inventory = useInventory();
  const enrichment = useEnrichment();
  const jobs = useJobs();
  const client = useQueryClient();
  const { run, busy } = useAction();
  const [transcripts, setTranscripts] = useState(false);
  const usage = useQuery({ queryKey: [...keys.usage, transcripts], queryFn: () => api.usage(transcripts) });
  const [budget, setBudget] = useState('');
  const [turns, setTurns] = useState('');
  const [project, setProject] = useState('');

  useEffect(() => {
    if (settings.data) {
      setBudget(settings.data.audit.budgetUsd.toFixed(2));
      setTurns(String(settings.data.audit.maxTurns));
    }
  }, [settings.data]);

  if (settings.error) return <div className="page"><ErrorBox error={settings.error} /></div>;
  const s = settings.data;
  const save = (patch: Parameters<typeof api.saveSettings>[0], message?: string) =>
    run('save', async () => client.setQueryData(keys.settings, await api.saveSettings(patch)), message);
  const trendingJob = (jobs.data ?? []).find((j) => j.kind === 'trending-index');
  const indexing = trendingJob && (trendingJob.state === 'running' || trendingJob.state === 'queued');

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <TitleRow title="Settings" lede="Stored in ~/.skillhangar on this machine. Nothing here is sent anywhere." />

      <section className="settings-row" aria-labelledby="net">
        <div>
          <h2 id="net">Network lookups</h2>
          <p>Off by default. When on, Skillhangar contacts only these services, sends repository and package names, and never sends file contents, keys or your identity.</p>
        </div>
        <div className="settings-panel">
          <label className="check" style={{ alignItems: 'center' }}>
            <input type="checkbox" className="switch" checked={!!s?.network.enabled} disabled={!s || busy === 'save'} onChange={(e) => save({ network: { enabled: e.target.checked } }, e.target.checked ? 'Network lookups on. Checking sources now.' : 'Network lookups off.')} />
            <span>{s?.network.enabled ? 'On' : 'Off'}{s?.network.decidedAt ? <span className="muted"> · since {date(s.network.decidedAt)}</span> : null}</span>
          </label>
          <ul className="endpoint-list">
            {ENDPOINTS.map((e) => <li key={e}>{e}</li>)}
          </ul>
          {enrichment.data?.rateLimit ? <p className="faint" style={{ fontSize: 12 }}>GitHub quota left: {n(enrichment.data.rateLimit.remaining)} of {n(enrichment.data.rateLimit.limit)}</p> : null}
        </div>
      </section>

      <section className="settings-row" aria-labelledby="trend">
        <div>
          <h2 id="trend">GitHub Trending history</h2>
          <p>
            GitHub has no trending API. Skillhangar indexes a community archive of the daily Trending page (antonkomarev/github-trending-archive, from 31 Dec 2021) to show the days each source
            repository trended. The first build fetches about 1,800 small files; later runs fetch only new days.
          </p>
        </div>
        <div className="settings-panel">
          <div>{enrichment.data?.trendingIndexedThrough ? `Indexed through ${date(enrichment.data.trendingIndexedThrough)}` : 'Not built yet'}</div>
          {indexing && trendingJob?.progress ? (
            <div className="muted num">{n(trendingJob.progress.done)} of {n(trendingJob.progress.total)} days</div>
          ) : null}
          <button className="btn" style={{ justifySelf: 'start' }} disabled={!s?.network.enabled || !!indexing} onClick={() => run('trend', api.buildTrending)}>
            {indexing ? 'Indexing…' : enrichment.data?.trendingIndexedThrough ? 'Update the index' : 'Build the index'}
          </button>
        </div>
      </section>

      <section className="settings-row" aria-labelledby="audit">
        <div>
          <h2 id="audit">Claude audits</h2>
          <p>Defaults for the audit dialog. Audits run on your own claude CLI, so they use your plan or API key.</p>
        </div>
        <div className="settings-panel">
          <label className="field">
            <span>Default model</span>
            <select className="select" value={s?.audit.defaultModel ?? 'sonnet'} onChange={(e) => save({ audit: { defaultModel: e.target.value } })}>
              {MODEL_CHOICES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {s && !MODEL_CHOICES.some((m) => m.id === s.audit.defaultModel) ? <option value={s.audit.defaultModel}>{s.audit.defaultModel}</option> : null}
            </select>
          </label>
          <div className="grid grid-1-1">
            <label className="field">
              <span>Spend cap per skill (USD)</span>
              <input className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => Number(budget) >= 0.01 && Number(budget) <= 20 && save({ audit: { budgetUsd: Number(budget) } })} />
            </label>
            <label className="field">
              <span>Turn limit</span>
              <input className="input num" inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value)} onBlur={() => Number(turns) >= 2 && Number(turns) <= 100 && save({ audit: { maxTurns: Number(turns) } })} />
            </label>
          </div>
        </div>
      </section>

      <section className="settings-row" aria-labelledby="usage">
        <div>
          <h2 id="usage">Usage tracking</h2>
          <p>
            Adds two hooks to a profile's settings.json that append one line to ~/.skillhangar/usage.jsonl when Claude invokes a skill or you type /name. They never block a session. Turn off removes
            exactly those two entries.
          </p>
        </div>
        <div className="settings-panel">
          {(inventory.data?.profiles ?? []).map((p) => (
            <label key={p.id} className="check" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                className="switch"
                checked={!!usage.data?.hookInstalled[p.id]}
                disabled={busy === `hook-${p.id}`}
                onChange={(e) => run(`hook-${p.id}`, async () => {
                  await api.usageHook(p.id, e.target.checked);
                  await usage.refetch();
                }, e.target.checked ? `Tracking usage in ${p.label}. Takes effect in new sessions.` : `Stopped tracking ${p.label}.`)}
              />
              <span className="mono">{tildify(p.configDir)}/settings.json</span>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={transcripts} onChange={(e) => setTranscripts(e.target.checked)} />
            <span>Also estimate from the last 90 days of session transcripts (their format is internal to Claude Code, so counts are estimates)</span>
          </label>
          {usage.data?.skills.length ? (
            <ul className="barlist">
              {usage.data.skills.slice(0, 8).map((u) => (
                <li key={u.name}>
                  <div className="row">
                    <span>{u.name}</span>
                    <span className="muted num">{n(u.count)} · {ago(u.lastUsed)}</span>
                  </div>
                  <div className="track"><div className="fill" style={{ width: `${(u.count / usage.data!.skills[0]!.count) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No usage recorded yet.</p>
          )}
        </div>
      </section>

      <section className="settings-row" aria-labelledby="projects">
        <div>
          <h2 id="projects">Projects</h2>
          <p>Skillhangar finds projects from Claude Code's own records. Add a folder it has not seen to include its skills and servers.</p>
        </div>
        <div className="settings-panel">
          <form
            style={{ display: 'flex', gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (project.trim() && s) void save({ projects: [...s.projects, project.trim()] }, 'Project added. Rescanning.').then(() => setProject(''));
            }}
          >
            <input className="input mono" style={{ flex: 1 }} value={project} onChange={(e) => setProject(e.target.value)} placeholder="/absolute/path/to/project" aria-label="Project folder" />
            <button className="btn" type="submit" disabled={!project.trim()}>Add</button>
          </form>
          <ul className="endpoint-list">
            {(inventory.data?.projects ?? []).map((p) => (
              <li key={p} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="truncate">{tildify(p)}</span>
                {s?.projects.includes(p) ? <button className="link" onClick={() => save({ projects: s.projects.filter((x) => x !== p) })}>Remove</button> : null}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="settings-row" aria-labelledby="profiles">
        <div>
          <h2 id="profiles">Profiles</h2>
          <p>Claude Code configuration folders on this machine. The active one is set by CLAUDE_CONFIG_DIR.</p>
        </div>
        <div className="settings-panel">
          <dl className="kv">
            {(inventory.data?.profiles ?? []).map((p) => (
              <div key={p.id} style={{ display: 'contents' }}>
                <dt>{p.label}{p.isActive ? ' (active)' : ''}</dt>
                <dd className="mono">{tildify(p.skillsRealDir ?? p.skillsDir)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="settings-row" aria-labelledby="data">
        <div>
          <h2 id="data">Your setup as a file</h2>
          <p>A manifest of where each skill came from and how each MCP server starts. It holds key names only, never values, so it is safe to share with a team.</p>
        </div>
        <div className="settings-panel">
          <a className="btn" style={{ justifySelf: 'start' }} href="/api/manifest" download="skillhangar.json">Download skillhangar.json</a>
          <p className="faint" style={{ fontSize: 12 }}>Unofficial. Not affiliated with Anthropic. The Claude symbol is a trademark of Anthropic.</p>
        </div>
      </section>
    </div>
  );
}
