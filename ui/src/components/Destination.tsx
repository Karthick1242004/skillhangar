import { useEffect, useState } from 'react';
import { useInventory } from '../lib/data';
import { tildify } from '../lib/format';
import type { InstallDestination } from '@shared/types';

/** Where a skill goes: globally into a Claude profile, or into one project's `.claude/skills`. */
export function DestinationPicker({ value, onChange, mode, onModeChange }: { value: InstallDestination | null; onChange: (d: InstallDestination) => void; mode: 'copy' | 'symlink'; onModeChange: (m: 'copy' | 'symlink') => void }) {
  const inventory = useInventory();
  const profiles = inventory.data?.profiles ?? [];
  const projects = inventory.data?.projects ?? [];
  const [kind, setKind] = useState<'profile' | 'project'>(value?.kind ?? 'profile');
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (!value && profiles.length) onChange({ kind: 'profile', profileId: (profiles.find((p) => p.isActive) ?? profiles[0]!).id });
  }, [value, profiles, onChange]);

  // Profiles sharing one skills folder install to the same place; show them once.
  const uniqueProfiles = profiles.filter((p, i) => profiles.findIndex((q) => (q.skillsRealDir ?? q.skillsDir) === (p.skillsRealDir ?? p.skillsDir)) === i);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="seg" role="group" aria-label="Install scope">
        <button
          aria-pressed={kind === 'profile'}
          onClick={() => {
            setKind('profile');
            onChange({ kind: 'profile', profileId: (profiles.find((p) => p.isActive) ?? profiles[0])?.id ?? 'default' });
          }}
        >
          Global (every project)
        </button>
        <button
          aria-pressed={kind === 'project'}
          onClick={() => {
            setKind('project');
            if (projects[0]) onChange({ kind: 'project', path: projects[0] });
          }}
        >
          One project
        </button>
      </div>
      {kind === 'profile' ? (
        <label className="field">
          <span>Profile</span>
          <select className="select" value={value?.kind === 'profile' ? value.profileId : ''} onChange={(e) => onChange({ kind: 'profile', profileId: e.target.value })}>
            {uniqueProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {tildify(p.skillsDir)}
                {p.isActive ? ' (active)' : ''}
                {profiles.filter((q) => q.skillsRealDir && q.skillsRealDir === p.skillsRealDir).length > 1 ? ', shared by several profiles' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="field">
          <span>Project folder</span>
          <select
            className="select"
            value={value?.kind === 'project' && projects.includes(value.path) ? value.path : '__custom'}
            onChange={(e) => (e.target.value === '__custom' ? onChange({ kind: 'project', path: custom }) : onChange({ kind: 'project', path: e.target.value }))}
          >
            {projects.map((p) => (
              <option key={p} value={p}>
                {tildify(p)}
              </option>
            ))}
            <option value="__custom">Another folder…</option>
          </select>
          {value?.kind === 'project' && !projects.includes(value.path) ? (
            <input
              className="input mono"
              placeholder="/absolute/path/to/project"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                onChange({ kind: 'project', path: e.target.value });
              }}
            />
          ) : null}
          <span className="hint">The skill goes into the project's .claude/skills folder.</span>
        </label>
      )}
      <label className="field">
        <span>How</span>
        <select className="select" value={mode} onChange={(e) => onModeChange(e.target.value as 'copy' | 'symlink')}>
          <option value="copy">Copy the files</option>
          <option value="symlink">Link to one shared copy (keeps several projects in step)</option>
        </select>
      </label>
    </div>
  );
}
