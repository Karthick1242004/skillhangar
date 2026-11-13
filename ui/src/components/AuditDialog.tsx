import { useEffect, useState } from 'react';
import { MODEL_CHOICES } from '@shared/types';
import { Dialog } from './ui';
import type { AuditOptions } from '../api';
import { useSettings } from '../lib/data';

/**
 * Model and spend cap for a Claude audit. The audit runs through the user's own `claude` CLI, so the
 * cost lands on their plan or API key; the cap is passed as --max-budget-usd and enforced by the CLI.
 */
export function AuditDialog({ open, onClose, onStart, subject, count = 1 }: { open: boolean; onClose: () => void; onStart: (options: AuditOptions) => void; subject: string; count?: number }) {
  const settings = useSettings();
  const [model, setModel] = useState('sonnet');
  const [custom, setCustom] = useState('');
  const [budget, setBudget] = useState('0.50');
  const [turns, setTurns] = useState('24');

  useEffect(() => {
    if (!open || !settings.data) return;
    const preset = MODEL_CHOICES.some((m) => m.id === settings.data.audit.defaultModel);
    setModel(preset ? settings.data.audit.defaultModel : 'custom');
    setCustom(preset ? '' : settings.data.audit.defaultModel);
    setBudget(settings.data.audit.budgetUsd.toFixed(2));
    setTurns(String(settings.data.audit.maxTurns));
  }, [open, settings.data]);

  const chosen = model === 'custom' ? custom.trim() : model;
  const budgetNumber = Number(budget);
  const valid = /^[\w.[\]-]{2,64}$/.test(chosen) && budgetNumber >= 0.01 && budgetNumber <= 20 && Number(turns) >= 2;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={count > 1 ? `Audit ${count} skills with Claude` : `Audit ${subject} with Claude`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onStart({ model: chosen, budgetUsd: budgetNumber, maxTurns: Number(turns) })}>
            Start audit{count > 1 ? `s (up to $${(budgetNumber * count).toFixed(2)})` : ''}
          </button>
        </>
      }
    >
      <p className="muted">
        Claude reads the skill as untrusted data in an isolated session with only Read, Grep and Glob, no MCP servers and no other skills. Its verdict can raise the
        static verdict, never lower it.
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontWeight: 500, marginBottom: 8 }}>Model</legend>
        {MODEL_CHOICES.map((m) => (
          <label key={m.id} className="check">
            <input type="radio" name="model" checked={model === m.id} onChange={() => setModel(m.id)} />
            <span>
              {m.label} <span className="muted">· {m.note}</span>
            </span>
          </label>
        ))}
        <label className="check">
          <input type="radio" name="model" checked={model === 'custom'} onChange={() => setModel('custom')} />
          <span>Another model id</span>
        </label>
        {model === 'custom' ? <input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="claude-sonnet-5-5" aria-label="Model id" /> : null}
      </fieldset>
      <div className="grid grid-1-1">
        <label className="field">
          <span>Spend cap per skill (USD)</span>
          <input className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby="budget-hint" />
          <span className="hint" id="budget-hint">
            From $0.01 to $20. The audit stops when it reaches the cap.
          </span>
        </label>
        <label className="field">
          <span>Turn limit</span>
          <input className="input num" inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
