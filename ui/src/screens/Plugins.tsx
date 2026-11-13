import { useState } from 'react';
import { api } from '../api';
import { Dialog, Empty, ErrorBox, TitleRow, useAction } from '../components/ui';
import { useInventory } from '../lib/data';
import { date, n, plural, tildify } from '../lib/format';
import type { PluginRecord } from '@shared/types';

export function Plugins() {
  const inventory = useInventory();
  const { run, busy } = useAction();
  const [removing, setRemoving] = useState<PluginRecord | null>(null);
  if (inventory.error) return <div className="page"><ErrorBox error={inventory.error} /></div>;
  const plugins = inventory.data?.plugins ?? [];
  const profiles = inventory.data?.profiles ?? [];
  const skillCount = plugins.reduce((sum, p) => sum + (p.enabled !== false ? p.skillCount : 0), 0);
  const profileFor = (p: PluginRecord) => profiles.find((x) => p.profileIds.includes(x.id) && x.isActive)?.id ?? p.profileIds[0]!;

  return (
    <div className="page">
      <TitleRow
        title="Plugins"
        lede={plugins.length ? `${plural(plugins.filter((p) => p.enabled !== false).length, 'plugin')} enabled, bringing ${plural(skillCount, 'skill')}. Changes run through claude plugin.` : undefined}
      />
      {plugins.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Version</th>
                <th>Scope</th>
                <th className="num">Skills</th>
                <th className="num">Installed</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => {
                const key = `${p.id}-${p.installPath}-${p.projectPath ?? ''}`;
                return (
                  <tr key={key}>
                    <td style={{ maxWidth: 0, width: '32%' }}>
                      <div className="cell-title">{p.name}</div>
                      <div className="cell-sub truncate">{p.marketplace}{p.marketplaceRepo ? ` · ${p.marketplaceRepo}` : ''}</div>
                    </td>
                    <td className="secondary">
                      <span className="mono">{p.version.length > 14 ? p.version.slice(0, 12) : p.version}</span>
                    </td>
                    <td className="hide-phone">
                      {p.scope}
                      {p.projectPath ? <div className="cell-sub truncate" style={{ maxWidth: 160 }}>{tildify(p.projectPath)}</div> : null}
                    </td>
                    <td className="num hide-phone">{n(p.skillCount)}</td>
                    <td className="num hide-phone">{date(p.installedAt)}</td>
                    <td>
                      <input
                        type="checkbox"
                        className="switch"
                        aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
                        checked={p.enabled !== false}
                        disabled={busy === key}
                        onChange={(e) => run(key, () => api.pluginAction(p.id, e.target.checked ? 'enable' : 'disable', profileFor(p)), `${p.name} ${e.target.checked ? 'enabled' : 'disabled'}.`)}
                      />
                    </td>
                    <td className="cell-actions">
                      <button className="btn btn-sm" disabled={busy === `${key}-update`} onClick={() => run(`${key}-update`, () => api.pluginAction(p.id, 'update', profileFor(p)), `${p.name} updated.`)}>
                        {busy === `${key}-update` ? 'Updating…' : 'Update'}
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => setRemoving(p)}>
                        Uninstall
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No plugins installed.">Install plugins inside Claude Code with /plugin.</Empty>
      )}
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Uninstall ${removing?.name ?? ''}?`}
        footer={
          <>
            <button className="btn" onClick={() => setRemoving(null)}>Keep it</button>
            <button
              className="btn btn-danger"
              disabled={busy === 'uninstall'}
              onClick={async () => {
                if (removing && (await run('uninstall', () => api.pluginAction(removing.id, 'uninstall', profileFor(removing)), `${removing.name} uninstalled.`))) setRemoving(null);
              }}
            >
              Uninstall
            </button>
          </>
        }
      >
        <p>
          Runs <span className="mono">claude plugin uninstall {removing?.id}</span>. Its {plural(removing?.skillCount ?? 0, 'skill')} stop loading. Reinstall it from its marketplace with /plugin.
        </p>
      </Dialog>
    </div>
  );
}
