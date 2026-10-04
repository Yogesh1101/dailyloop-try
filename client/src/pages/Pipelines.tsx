import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EFFORTS, type Pipeline } from '@harness/shared';
import { api, editable, type PipelineDoc } from '../api';
import { Card, Check, Field, ListEditor, NumberInput, PageHead, Select, TextArea, TextInput, useToast } from '../components/ui';
import { gateBadges } from './Operations';

export function Pipelines() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const ops = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const create = useMutation({
    mutationFn: () => api.post<PipelineDoc>('/pipelines', { key: `pipeline-${Date.now().toString(36)}`, name: 'New pipeline', stages: [{ operationKey: 'plan' }] }),
    onSuccess: (p) => (qc.invalidateQueries({ queryKey: ['pipelines'] }), nav(`/pipelines/${p._id}`)),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="stack lg">
      <PageHead
        title="Pipelines"
        sub="A pipeline is the delivery workflow: an ordered set of operations with a project constitution, global guardrails and a run budget. Every run freezes its pipeline at creation."
        actions={<button className="btn primary" onClick={() => create.mutate()}>New pipeline</button>}
      />
      <div className="stack">
        {(pipelines.data ?? []).map((p) => (
          <Link key={p._id} to={`/pipelines/${p._id}`} className="card card-pad" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row between">
              <div className="row">
                <strong>{p.name}</strong>
                {p.builtIn && <span className="tag">built-in</span>}
              </div>
              <span className="small muted">budget ${p.maxRunCostUsd} per run</span>
            </div>
            <p className="small ink-2" style={{ marginTop: 4 }}>{p.description}</p>
            <div className="row" style={{ marginTop: 10 }}>
              {p.stages.map((s, i) => {
                const op = ops.data?.find((o) => o.key === s.operationKey);
                const human = op?.gates.some((g) => g.type === 'human_approval' && g.enabled);
                return (
                  <span key={i} className="row" style={{ gap: 6 }}>
                    {i > 0 && <span className="muted">→</span>}
                    <span className={`pill ${human ? 'warning' : ''}`}>{human ? '✋ ' : ''}{op?.name ?? s.operationKey}</span>
                  </span>
                );
              })}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function PipelineEdit() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ['pipeline', id], queryFn: () => api.get<PipelineDoc>(`/pipelines/${id}`) });
  const ops = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const [draft, setDraft] = useState<Pipeline | null>(null);
  const [adding, setAdding] = useState('');
  const [bulk, setBulk] = useState({ provider: '', model: '' });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  useEffect(() => {
    if (doc.data) setDraft(editable(doc.data) as Pipeline);
  }, [doc.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['pipeline', id] });
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
  };
  const save = useMutation({ mutationFn: () => api.put(`/pipelines/${id}`, draft), onSuccess: () => (toast('Pipeline saved'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const dup = useMutation({ mutationFn: () => api.post<PipelineDoc>(`/pipelines/${id}/duplicate`), onSuccess: (p) => (refresh(), nav(`/pipelines/${p._id}`)), onError: (e: Error) => toast(e.message, 'error') });
  const reset = useMutation({ mutationFn: () => api.post(`/pipelines/${id}/reset`), onSuccess: () => (toast('Reset'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const del = useMutation({ mutationFn: () => api.del(`/pipelines/${id}`), onSuccess: () => (toast('Deleted'), qc.invalidateQueries({ queryKey: ['pipelines'] }), nav('/pipelines')), onError: (e: Error) => toast(e.message, 'error') });

  if (!draft) return <p className="muted">Loading…</p>;
  const set = <K extends keyof Pipeline>(k: K, v: Pipeline[K]) => setDraft({ ...draft, [k]: v });
  const move = (i: number, d: number) => {
    const next = [...draft.stages];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s);
    set('stages', next);
  };
  const used = new Set(draft.stages.map((s) => s.operationKey));

  return (
    <div className="stack lg">
      <PageHead
        title={draft.name}
        sub={draft.description}
        actions={
          <>
            <Link className="btn" to={`/runs/new?pipeline=${id}`}>New run</Link>
            <Link className="btn" to={`/export?pipeline=${id}`}>Export</Link>
            <button className="btn" onClick={() => dup.mutate()}>Duplicate</button>
            {draft.builtIn && <button className="btn" onClick={() => confirm('Restore the built-in definition?') && reset.mutate()}>Reset</button>}
            {!draft.builtIn && <button className="btn ghost danger" onClick={() => confirm('Delete this pipeline?') && del.mutate()}>Delete</button>}
            <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
          </>
        }
      />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Card title="Stages" sub="Operations run in this order. Each stage's gates must pass before the next begins.">
            <div className="stack">
              <div className="editor-block stack sm">
                <span className="label">Use one provider and model for every stage</span>
                <div className="grid cols-2" style={{ gap: 8 }}>
                  <Select value={bulk.provider} onChange={(v) => setBulk({ provider: v, model: '' })} placeholder="Provider…" options={(providers.data ?? []).map((p) => ({ value: p.id, label: `${p.label}${p.configured ? '' : ' (not configured)'}` }))} />
                  <div>
                    <input className="input code" list="bulk-models" placeholder="Model id" value={bulk.model} onChange={(e) => setBulk({ ...bulk, model: e.target.value })} />
                    <datalist id="bulk-models">
                      {(settings.data?.models ?? []).filter((m) => m.provider === bulk.provider).map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </datalist>
                  </div>
                </div>
                <div className="row end">
                  <button className="btn ghost" onClick={() => set('stages', draft.stages.map((x) => ({ ...x, overrides: { ...x.overrides, provider: undefined, model: undefined } })))}>
                    Clear overrides
                  </button>
                  <button
                    className="btn"
                    disabled={!bulk.provider || !bulk.model.trim()}
                    onClick={() => set('stages', draft.stages.map((x) => ({ ...x, overrides: { ...x.overrides, provider: bulk.provider, model: bulk.model.trim() } })))}
                  >
                    Apply to all stages
                  </button>
                </div>
                <span className="hint small muted">Sets each stage's override; the operations keep their own defaults. Save to keep it.</span>
              </div>
              {draft.stages.map((s, i) => {
                const op = ops.data?.find((o) => o.key === s.operationKey);
                const o = s.overrides ?? {};
                const setO = (k: string, v: string | undefined) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, overrides: { ...x.overrides, [k]: v || undefined } } : x)));
                return (
                  <div key={i} className="editor-block stack sm">
                    <div className="row between">
                      <div className="row">
                        <span className="muted small">{i + 1}.</span>
                        <strong>{op ? <Link to={`/operations/${op._id}`}>{op.name}</Link> : <span className="pill critical">✕ unknown: {s.operationKey}</span>}</strong>
                        {op?.rewindTo && <span className="pill info">↺ {op.rewindTo}</span>}
                      </div>
                      <div className="row">
                        <button className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                        <button className="btn ghost sm" disabled={i === draft.stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                        <button className="btn ghost sm danger" onClick={() => set('stages', draft.stages.filter((_, j) => j !== i))}>Remove</button>
                      </div>
                    </div>
                    {op && <div className="row">{gateBadges(op)}</div>}
                    <details>
                      <summary className="small muted" style={{ cursor: 'pointer' }}>Overrides for this pipeline{o.provider || o.model || o.effort || o.extraInstructions ? ' (set)' : ''}</summary>
                      <div className="stack sm" style={{ marginTop: 8 }}>
                        <div className="grid cols-3">
                          <Field label="Provider"><Select value={o.provider ?? ''} onChange={(v) => setO('provider', v)} placeholder={`(${op?.provider ?? 'default'})`} options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.label }))} /></Field>
                          <Field label="Model"><TextInput mono value={o.model} onChange={(v) => setO('model', v)} placeholder={op?.model} /></Field>
                          <Field label="Effort"><Select value={o.effort ?? ''} onChange={(v) => setO('effort', v)} placeholder={`(${op?.effort ?? 'default'})`} options={EFFORTS.map((e) => ({ value: e, label: e }))} /></Field>
                        </div>
                        <Field label="Extra instructions (appended for this pipeline only)"><TextArea rows={3} value={o.extraInstructions ?? ''} onChange={(v) => setO('extraInstructions', v)} /></Field>
                      </div>
                    </details>
                  </div>
                );
              })}
              <div className="row">
                <Select value={adding} onChange={setAdding} placeholder="Add an operation…" options={(ops.data ?? []).filter((o) => !used.has(o.key)).map((o) => ({ value: o.key, label: o.name }))} />
                <button className="btn" disabled={!adding} onClick={() => (set('stages', [...draft.stages, { operationKey: adding, overrides: {} }]), setAdding(''))}>Add stage</button>
              </div>
            </div>
          </Card>
        </div>
        <div className="stack">
          <Card title="Basics">
            <div className="stack">
              <div className="grid cols-2">
                <Field label="Name"><TextInput value={draft.name} onChange={(v) => set('name', v)} /></Field>
                <Field label="Key"><TextInput mono value={draft.key} onChange={(v) => set('key', v)} /></Field>
              </div>
              <Field label="Description"><TextArea rows={2} value={draft.description} onChange={(v) => set('description', v)} /></Field>
              <div className="grid cols-2">
                <Field label="Run budget (USD)" hint="Hard ceiling across all stages of one run"><NumberInput value={draft.maxRunCostUsd} onChange={(v) => set('maxRunCostUsd', v)} step="1" /></Field>
                <Field label="Knowledge"><Check checked={draft.captureKnowledge} onChange={(v) => set('captureKnowledge', v)} label="Capture marked artifacts when a run completes" /></Field>
              </div>
            </div>
          </Card>
          <Card title="Constitution" sub="Non-negotiable project rules injected into every stage of every run.">
            <TextArea rows={9} value={draft.constitution} onChange={(v) => set('constitution', v)} />
          </Card>
          <Card title="Global guardrails" sub="Added to every operation in this pipeline. Operations can add more but never remove these.">
            <div className="stack">
              <Field label="Forbidden paths (globs)"><ListEditor value={draft.globalPolicy.forbiddenPaths} onChange={(v) => set('globalPolicy', { ...draft.globalPolicy, forbiddenPaths: v })} /></Field>
              <Field label="Denied commands (regex)"><ListEditor value={draft.globalPolicy.commandDenylist} onChange={(v) => set('globalPolicy', { ...draft.globalPolicy, commandDenylist: v })} /></Field>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
