import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../components/icons';
import { Empty, ErrorBox, Tabs, TitleRow, useAction } from '../components/ui';
import { keys } from '../lib/data';
import { ago, date, time, tildify } from '../lib/format';

const ACTION_LABEL: Record<string, string> = {
  install: 'Installed',
  remove: 'Removed',
  update: 'Updated',
  copy: 'Copied',
  override: 'Changed visibility of',
  review: 'Reviewed',
  'claude-audit': 'Claude audited',
  'link-origin': 'Recorded the origin of',
  rollback: 'Rolled back',
  restore: 'Restored',
  'mcp-add': 'Added MCP server',
  'mcp-remove': 'Removed MCP server',
  'usage-hook-on': 'Turned on usage tracking for',
  'usage-hook-off': 'Turned off usage tracking for',
};

export function Activity() {
  const [tab, setTab] = useState<'log' | 'trash'>('log');
  const activity = useQuery({ queryKey: keys.activity, queryFn: api.activity });
  const trash = useQuery({ queryKey: keys.trash, queryFn: api.trash });
  const { run, busy } = useAction();

  return (
    <div className="page">
      <TitleRow title="Activity" lede="Everything Skillhangar changed on this machine. Removals and updates can be undone." />
      <Tabs
        label="Activity"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'log', label: 'Log', count: activity.data?.entries.length },
          { id: 'trash', label: 'Trash', count: trash.data?.items.length },
        ]}
      />
      {tab === 'log' ? (
        activity.error ? (
          <ErrorBox error={activity.error} />
        ) : activity.data?.entries.length ? (
          <table className="table responsive">
            <tbody>
              {activity.data.entries.map((e) => {
                const label = e.action.startsWith('plugin-') ? `Plugin ${e.action.slice(7)}:` : (ACTION_LABEL[e.action] ?? e.action);
                return (
                  <tr key={e.id}>
                    <td className="num muted" style={{ width: 150, whiteSpace: 'nowrap' }}>
                      {date(e.at)} {time(e.at)}
                    </td>
                    <td style={{ maxWidth: 0 }}>
                      <div>
                        {label} <strong>{e.target}</strong>
                        {e.undone ? <span className="pill outline" style={{ marginLeft: 8 }}>Undone</span> : null}
                      </div>
                      {e.detail ? <div className="cell-sub truncate">{tildify(e.detail)}</div> : null}
                    </td>
                    <td className="cell-actions">
                      {e.undo && !e.undone ? (
                        <button className="btn btn-sm" disabled={busy === e.id} onClick={() => run(e.id, () => api.undo(e.id), 'Undone.')}>
                          <Icon name="undo" size={14} /> Undo
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing changed yet." />
        )
      ) : trash.error ? (
        <ErrorBox error={trash.error} />
      ) : trash.data?.items.length ? (
        <table className="table responsive">
          <thead>
            <tr>
              <th>Item</th>
              <th>Was at</th>
              <th className="num">Removed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trash.data.items.map((item) => (
              <tr key={item.id}>
                <td className="cell-title">{item.name}{item.kind === 'snapshot-replaced' ? <div className="cell-sub">Replaced by a rollback</div> : null}</td>
                <td className="secondary mono truncate" style={{ maxWidth: 320 }}>{tildify(item.originalPath)}</td>
                <td className="num">{ago(item.trashedAt)}</td>
                <td className="cell-actions">
                  <button className="btn btn-sm" disabled={busy === item.id} onClick={() => run(item.id, () => api.restoreTrash(item.id), `${item.name} restored.`)}>
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="The trash is empty.">Removed skills stay here for 30 days.</Empty>
      )}
    </div>
  );
}
