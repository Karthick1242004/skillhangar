import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { VERDICT_LABEL } from '../lib/format';
import type { Severity, Verdict } from '@shared/types';

export function VerdictPill({ verdict, reviewed }: { verdict: Verdict; reviewed?: boolean }) {
  if (reviewed && verdict !== 'safe' && verdict !== 'unknown') return <span className="pill outline">Reviewed</span>;
  if (verdict === 'unknown') return <span className="pill outline">{VERDICT_LABEL.unknown}</span>;
  return (
    <span className={`pill ${verdict}`}>
      <span className="dot" />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function SeverityLabel({ severity }: { severity: Severity }) {
  return <span className={`sev-label ${severity}`}>{severity}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <div style={{ marginTop: 4 }}>{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error-box" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
}

/** A modal on the native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'wide' : undefined} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="dialog-title">
      {open ? (
        <>
          <div className="dialog-head">
            <h2 id="dialog-title">{title}</h2>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(message: string, options?: { kind?: Toast['kind']; action?: Toast['action'] }) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, options: { kind?: Toast['kind']; action?: Toast['action'] } = {}) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, message, kind: options.kind ?? 'info', action: options.action }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), options.kind === 'error' ? 9000 : 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <span>{t.message}</span>
            {t.action ? (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Runs an async action with a busy flag and reports failure as a toast; returns the result or undefined. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, action: () => Promise<T>, success?: string | ((result: T) => string)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const result = await action();
        if (success) toast(typeof success === 'function' ? success(result) : success);
        return result;
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

export function TitleRow({ title, lede, actions, crumbs }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="title-row">
      <div style={{ minWidth: 0 }}>
        {crumbs ? <div className="crumbs">{crumbs}</div> : null}
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="title-actions">{actions}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" className="tab" aria-selected={value === tab.id} onClick={() => onChange(tab.id)}>
          {tab.label}
          {tab.count !== undefined ? <span className="count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
