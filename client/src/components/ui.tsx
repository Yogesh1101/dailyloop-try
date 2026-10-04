import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunStatus, StageStatus } from '@harness/shared';

/* ------------------------------------------------------------------ toasts */

type Toast = { id: number; text: string; kind: 'info' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------------------------------------------ status */

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'info' | 'neutral';
const RUN_TONE: Record<RunStatus, [Tone, string, string]> = {
  queued: ['neutral', '◷', 'Queued'],
  running: ['info', '●', 'Running'],
  awaiting_approval: ['warning', '✋', 'Awaiting approval'],
  blocked: ['serious', '■', 'Blocked'],
  completed: ['good', '✓', 'Completed'],
  cancelled: ['neutral', '⊘', 'Cancelled'],
  error: ['critical', '!', 'Error'],
};
const STAGE_TONE: Record<StageStatus, [Tone, string, string]> = {
  pending: ['neutral', '○', 'Pending'],
  running: ['info', '●', 'Running'],
  gating: ['info', '◐', 'Gating'],
  awaiting_approval: ['warning', '✋', 'Awaiting approval'],
  passed: ['good', '✓', 'Passed'],
  failed: ['critical', '✕', 'Failed'],
  blocked: ['serious', '■', 'Blocked'],
  skipped: ['neutral', '–', 'Skipped'],
};

/** Status is always icon + label, never color alone. */
export function StatusPill({ status, kind = 'run', scheduled }: { status: string; kind?: 'run' | 'stage'; scheduled?: boolean }) {
  const map = kind === 'run' ? RUN_TONE : STAGE_TONE;
  const [tone, icon, label] = (map as Record<string, [Tone, string, string]>)[status] ?? ['neutral', '?', status];
  return (
    <span className={`pill ${tone}`}>
      <span aria-hidden>{icon}</span>
      {scheduled && status === 'queued' ? 'Scheduled' : label}
    </span>
  );
}

export function StageDots({ stages }: { stages: { status: string; name: string }[] }) {
  return (
    <div className="stages" aria-label={stages.map((s) => `${s.name}: ${s.status}`).join(', ')}>
      {stages.map((s, i) => (
        <span key={i} className={`stage-dot ${s.status}`} title={`${s.name}: ${s.status.replace('_', ' ')}`} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, actions, children, pad = true }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : 'card-scroll'}>{children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-head" style={{ borderTop: '1px solid var(--hairline)', borderBottom: 0, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function TextInput(props: { value: string | number | undefined; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean; disabled?: boolean; step?: string; min?: number }) {
  const { value, onChange, mono, ...rest } = props;
  return <input className={`input ${mono ? 'code' : ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

export function NumberInput({ value, onChange, step = '1', min }: { value: number; onChange: (v: number) => void; step?: string; min?: number }) {
  return <input className="input" type="number" value={Number.isFinite(value) ? value : ''} step={step} min={min} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />;
}

export function TextArea({ value, onChange, rows = 6, mono, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; mono?: boolean; placeholder?: string }) {
  return <textarea className={`input ${mono ? 'code' : ''}`} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Select<T extends string>({ value, onChange, options, placeholder }: { value: T | ''; onChange: (v: T) => void; options: { value: T; label: string }[]; placeholder?: string }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Editable list of strings (globs, regexes, headings...). */
export function ListEditor({ value, onChange, placeholder, mono = true }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || value.includes(v)) return;
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="stack sm">
      {value.length > 0 && (
        <div className="chips">
          {value.map((v, i) => (
            <span key={`${v}-${i}`} className="chip" style={mono ? undefined : { fontFamily: 'inherit' }}>
              {v}
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <input
          className={`input grow ${mono ? 'code' : ''}`}
          value={draft}
          placeholder={placeholder ?? 'Add and press Enter'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

export function KeyValueEditor({ value, onChange, keyPlaceholder, valuePlaceholder }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const entries = Object.entries(value);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  return (
    <div className="stack sm">
      {entries.map(([key, val]) => (
        <div className="kv" key={key}>
          <code>{key}</code>
          <input className="input code" value={val} onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
          <button
            type="button"
            className="btn ghost sm danger"
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="kv">
        <input className="input code" placeholder={keyPlaceholder ?? 'name'} value={k} onChange={(e) => setK(e.target.value)} />
        <input className="input code" placeholder={valuePlaceholder ?? 'command'} value={v} onChange={(e) => setV(e.target.value)} />
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            if (!k.trim()) return;
            onChange({ ...value, [k.trim()]: v });
            setK('');
            setV('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="out" style={{ maxHeight: 520 }}>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Spinner() {
  return <span className="muted small">Loading…</span>;
}
