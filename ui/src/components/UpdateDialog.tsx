import { useEffect, useState } from 'react';
import { PatchView } from './CodeView';
import { FindingList } from './Findings';
import { Dialog, ErrorBox, useAction, VerdictPill } from './ui';
import { api } from '../api';
import type { UpdatePreview } from '@shared/types';

/**
 * Update flow: the new version is downloaded into quarantine, diffed against what is installed and
 * re-audited. Only then can it be applied, and a version that adds a serious finding needs an explicit yes.
 */
export function UpdateDialog({ skillId, name, open, onClose }: { skillId: string; name: string; open: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ack, setAck] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setAck(false);
    let cancelled = false;
    api.checkUpdate(skillId).then(
      (p) => !cancelled && setPreview(p),
      (e) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [open, skillId]);

  const unchanged = preview && preview.diff.length === 0;
  const apply = async () => {
    const result = await run('apply', () => api.applyUpdate(skillId, ack), (r) => r.warning ?? `${name} updated. A snapshot of the old version was kept.`);
    if (result) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={`Update ${name}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!preview || !!unchanged || busy === 'apply' || (preview.newSerious.length > 0 && !ack)} onClick={apply}>
            {busy === 'apply' ? 'Updating…' : 'Apply update'}
          </button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      {!preview && !error ? <p className="muted">Downloading the latest version into quarantine and auditing it…</p> : null}
      {preview ? (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>
              Installed: <VerdictPill verdict={preview.auditBefore.verdict} />
            </span>
            <span>
              New version: <VerdictPill verdict={preview.auditAfter.verdict} />
            </span>
            <span className="muted">
              {preview.diff.length} file{preview.diff.length === 1 ? '' : 's'} changed · applied with {preview.method === 'vercel-cli' ? 'the skills CLI' : preview.method === 'git' ? 'git pull' : 'Skillhangar'}
            </span>
          </div>
          {unchanged ? <p className="notice">The installed copy already matches upstream.</p> : null}
          {preview.newSerious.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <h3 style={{ fontSize: 15 }}>New serious findings in this version</h3>
              <FindingList findings={preview.newSerious} />
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I read these findings and want to update anyway.</span>
              </label>
            </div>
          ) : null}
          <ul className="files">
            {preview.diff.map((file) => (
              <li key={file.path} style={{ display: 'block' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className={`pill ${file.status === 'added' ? 'safe' : file.status === 'removed' ? 'dangerous' : 'caution'}`}>{file.status}</span>
                  <button className="mono" onClick={() => setExpanded((p) => (p === file.path ? null : file.path))} disabled={!file.patch} aria-expanded={expanded === file.path}>
                    {file.path}
                  </button>
                  {file.binary ? <span className="faint">binary</span> : file.truncated ? <span className="faint">too large to show</span> : null}
                </div>
                {expanded === file.path && file.patch ? <div style={{ marginTop: 8 }}><PatchView patch={file.patch} /></div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Dialog>
  );
}
