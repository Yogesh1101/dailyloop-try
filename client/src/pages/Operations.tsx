import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EFFORTS, modelProblem, TOOL_NAMES, type ArtifactContract, type Gate, type Operation, type Policy } from '@harness/shared';
import { api, editable, type OperationDoc } from '../api';
import { Card, Check, Empty, Field, ListEditor, Markdown, Modal, NumberInput, PageHead, Seg, Select, Tabs, TextArea, TextInput, useToast } from '../components/ui';

const GATE_LABEL: Record<Gate['type'], string> = {
  artifacts: 'Artifact contracts',
  command: 'Command check',
  diff_scope: 'Diff scope',
  json_assert: 'JSON assertions',
  human_approval: 'Human approval',
};

export function gateBadges(op: Pick<Operation, 'gates'>) {
  return op.gates
    .filter((g) => g.enabled)
    .map((g) => (
      <span key={g.id} className={`pill ${g.type === 'human_approval' ? 'warning' : ''}`}>
        {g.type === 'human_approval' ? '✋' : '◆'} {g.name}
      </span>
    ));
}

/* ------------------------------------------------------------------- list */

export function Operations() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const create = useMutation({
    mutationFn: () =>
      api.post<OperationDoc>('/operations', {
        key: `custom-${Date.now().toString(36)}`,
        name: 'New operation',
        description: '',
        instructions: '**Goal:** …\n\nYou MUST:\n1. …\n\nYou MUST NOT:\n- …',
        skills: [],
        policy: { allowedTools: ['read_file', 'list_dir', 'search', 'write_file', 'finish'], writablePaths: ['{{artifactsDir}}/**'] },
        artifacts: [{ id: 'report', path: 'report.md', format: 'markdown', requiredHeadings: ['Summary'] }],
        gates: [{ id: 'contracts', name: 'Artifact contracts', type: 'artifacts' }],
      }),
    onSuccess: (op) => {
      void qc.invalidateQueries({ queryKey: ['operations'] });
      nav(`/operations/${op._id}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="stack lg">
      <PageHead
        title="Operations"
        sub="An operation is a contract for one kind of agent work: strict instructions, skills, model, tool and path guardrails, required artifacts, and the gates that must pass before anything moves on."
        actions={<button className="btn primary" onClick={() => create.mutate()}>New operation</button>}
      />
      <div className="stack">
        {(ops.data ?? []).map((o) => (
          <Link key={o._id} to={`/operations/${o._id}`} className="card card-pad" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row between">
              <div className="row">
                <strong>{o.name}</strong>
                <span className="tag mono">{o.key}</span>
                {o.builtIn && <span className="tag">built-in</span>}
              </div>
              <span className="tag mono">{o.provider}/{o.model} · {o.effort}</span>
            </div>
            <p className="small ink-2" style={{ marginTop: 4 }}>{o.description}</p>
            <div className="row" style={{ marginTop: 8 }}>
              {gateBadges(o)}
              {o.rewindTo && <span className="pill info">↺ rewinds to {o.rewindTo}</span>}
              <span className="tiny muted">tools: {o.policy.allowedTools.join(', ')}</span>
            </div>
          </Link>
        ))}
        {ops.data && !ops.data.length && <Empty title="No operations" />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- editors */

function PolicyEditor({ value, onChange }: { value: Policy; onChange: (p: Policy) => void }) {
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="stack">
      <Field label="Allowed tools" hint="Tools not listed are not offered to the agent; calling one anyway is a violation.">
        <div className="row">
          {TOOL_NAMES.map((t) => (
            <Check key={t} label={<code>{t}</code>} checked={value.allowedTools.includes(t)} onChange={(on) => set('allowedTools', on ? [...value.allowedTools, t] : value.allowedTools.filter((x) => x !== t))} />
          ))}
        </div>
      </Field>
      <div className="grid cols-2">
        <Field label="Writable paths (globs)" hint="Everything else is read-only. {{artifactsDir}} is this run's artifact folder. Writes elsewhere halt the run.">
          <ListEditor value={value.writablePaths} onChange={(v) => set('writablePaths', v)} placeholder="src/**" />
        </Field>
        <Field label="Extra forbidden paths (globs)" hint="Added to the pipeline's global list. No read, no write.">
          <ListEditor value={value.forbiddenPaths} onChange={(v) => set('forbiddenPaths', v)} placeholder="infra/**" />
        </Field>
        <Field label="Command allowlist (regex)" hint="When set, every command must match one. Leave empty to allow anything not denied.">
          <ListEditor value={value.commandAllowlist} onChange={(v) => set('commandAllowlist', v)} placeholder="^npm test\b" />
        </Field>
        <Field label="Extra command denylist (regex)" hint="Added to the pipeline's global denylist.">
          <ListEditor value={value.commandDenylist} onChange={(v) => set('commandDenylist', v)} placeholder="\bterraform\b" />
        </Field>
      </div>
      <div className="grid cols-4">
        <Field label="Max turns"><NumberInput value={value.maxTurns} onChange={(v) => set('maxTurns', v)} min={1} /></Field>
        <Field label="Max tokens (stage)"><NumberInput value={value.maxTokens} onChange={(v) => set('maxTokens', v)} step="1000" /></Field>
        <Field label="Max cost USD (stage)"><NumberInput value={value.maxCostUsd} onChange={(v) => set('maxCostUsd', v)} step="0.5" /></Field>
        <Field label="Timeout (minutes)"><NumberInput value={value.timeoutMinutes} onChange={(v) => set('timeoutMinutes', v)} /></Field>
        <Field label="Command timeout (s)"><NumberInput value={value.commandTimeoutSeconds} onChange={(v) => set('commandTimeoutSeconds', v)} /></Field>
      </div>
    </div>
  );
}

function ArtifactEditor({ value, onChange, onRemove }: { value: ArtifactContract; onChange: (a: ArtifactContract) => void; onRemove: () => void }) {
  const set = <K extends keyof ArtifactContract>(k: K, v: ArtifactContract[K]) => onChange({ ...value, [k]: v });
  const [schemaText, setSchemaText] = useState(value.jsonSchema ? JSON.stringify(value.jsonSchema, null, 2) : '');
  const [schemaErr, setSchemaErr] = useState('');
  return (
    <div className="editor-block stack">
      <div className="row between">
        <strong>{value.id || 'artifact'} <span className="muted small mono">{value.path}</span></strong>
        <button className="btn ghost sm danger" onClick={onRemove}>Remove</button>
      </div>
      <div className="grid cols-4">
        <Field label="Id"><TextInput mono value={value.id} onChange={(v) => set('id', v)} /></Field>
        <Field label="File (in artifacts dir)"><TextInput mono value={value.path} onChange={(v) => set('path', v)} /></Field>
        <Field label="Format"><Seg options={[{ id: 'markdown', label: 'Markdown' }, { id: 'json', label: 'JSON' }]} value={value.format} onChange={(v) => set('format', v)} /></Field>
        <Field label="Min characters"><NumberInput value={value.minChars} onChange={(v) => set('minChars', v)} min={0} /></Field>
      </div>
      <Field label="Description"><TextInput value={value.description} onChange={(v) => set('description', v)} /></Field>
      {value.format === 'markdown' && (
        <Field label="Required section headings" hint="Each must exist and contain content.">
          <ListEditor value={value.requiredHeadings} onChange={(v) => set('requiredHeadings', v)} mono={false} placeholder="Acceptance Criteria" />
        </Field>
      )}
      <Field label="Required patterns" hint="Regex (case-insensitive, multiline) that must match somewhere, with a human description shown to the agent.">
        <div className="stack sm">
          {value.requiredPatterns.map((p, i) => (
            <div className="kv" key={i}>
              <input className="input code" value={p.pattern} onChange={(e) => set('requiredPatterns', value.requiredPatterns.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))} />
              <input className="input" value={p.description} onChange={(e) => set('requiredPatterns', value.requiredPatterns.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <button className="btn ghost sm danger" onClick={() => set('requiredPatterns', value.requiredPatterns.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div><button className="btn sm" onClick={() => set('requiredPatterns', [...value.requiredPatterns, { pattern: '', description: '' }])}>Add pattern</button></div>
        </div>
      </Field>
      {value.format === 'json' && (
        <Field label="JSON Schema" hint={schemaErr || 'Validated with Ajv after the agent finishes.'}>
          <TextArea
            mono
            rows={8}
            value={schemaText}
            onChange={(t) => {
              setSchemaText(t);
              if (!t.trim()) {
                setSchemaErr('');
                return set('jsonSchema', undefined);
              }
              try {
                set('jsonSchema', JSON.parse(t));
                setSchemaErr('');
              } catch (e) {
                setSchemaErr(`Invalid JSON: ${(e as Error).message}`);
              }
            }}
          />
        </Field>
      )}
      <div className="row">
        {value.format === 'markdown' && <Check checked={value.rejectPlaceholders} onChange={(v) => set('rejectPlaceholders', v)} label="Reject placeholders (TODO/TBD/FIXME)" />}
        <Check checked={value.captureToKnowledge} onChange={(v) => set('captureToKnowledge', v)} label="Capture to knowledge base when the run completes" />
      </div>
    </div>
  );
}

function GateEditor({ value, onChange, onRemove, artifactIds }: { value: Gate; onChange: (g: Gate) => void; onRemove: () => void; artifactIds: string[] }) {
  const g = value as any;
  const set = (k: string, v: unknown) => onChange({ ...g, [k]: v });
  const changeType = (type: Gate['type']) => {
    const base = { id: g.id, name: g.name, enabled: g.enabled, onFail: g.onFail, type };
    const extra: Record<Gate['type'], object> = {
      artifacts: {},
      command: { check: 'test', required: true, timeoutSeconds: 600, expectExitCode: 0 },
      diff_scope: { planArtifact: 'plan_json', filesPath: 'tasks[].files', alwaysAllowed: [] },
      json_assert: { artifact: artifactIds[0] ?? '', assertions: [{ path: 'verdict', op: 'eq', value: 'approve', message: 'Verdict must be approve' }] },
      human_approval: { instructions: 'Review the stage output before the pipeline continues.', checklist: [] },
    };
    onChange({ ...base, ...extra[type] } as Gate);
  };
  return (
    <div className="editor-block stack">
      <div className="row between">
        <div className="row">
          <strong>{g.name || 'Gate'}</strong>
          <span className="tag mono">{g.type}</span>
          <Check checked={g.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        </div>
        <button className="btn ghost sm danger" onClick={onRemove}>Remove</button>
      </div>
      <div className="grid cols-4">
        <Field label="Id"><TextInput mono value={g.id} onChange={(v) => set('id', v)} /></Field>
        <Field label="Name"><TextInput value={g.name} onChange={(v) => set('name', v)} /></Field>
        <Field label="Type">
          <Select value={g.type} onChange={(v) => changeType(v as Gate['type'])} options={Object.entries(GATE_LABEL).map(([value, label]) => ({ value: value as Gate['type'], label }))} />
        </Field>
        {g.type !== 'human_approval' && (
          <Field label="On failure" hint={g.onFail === 'rewind' ? 'Sends the failure to the rewind stage' : g.onFail === 'halt' ? 'Blocks the run immediately' : 'Feeds the failure back to the agent'}>
            <Select value={g.onFail} onChange={(v) => set('onFail', v)} options={[{ value: 'retry', label: 'Retry stage' }, { value: 'rewind', label: 'Rewind' }, { value: 'halt', label: 'Halt' }]} />
          </Field>
        )}
      </div>
      {g.type === 'command' && (
        <div className="grid cols-4">
          <Field label="Repo check name" hint="Uses the repository's check command"><TextInput mono value={g.check} onChange={(v) => set('check', v || undefined)} placeholder="test" /></Field>
          <Field label="…or literal command"><TextInput mono value={g.command} onChange={(v) => set('command', v || undefined)} placeholder="npm run e2e" /></Field>
          <Field label="Timeout (s)"><NumberInput value={g.timeoutSeconds} onChange={(v) => set('timeoutSeconds', v)} /></Field>
          <Field label="Expected exit code"><NumberInput value={g.expectExitCode} onChange={(v) => set('expectExitCode', v)} /></Field>
          <Check checked={g.required} onChange={(v) => set('required', v)} label="Fail if the repo lacks this check" />
        </div>
      )}
      {g.type === 'diff_scope' && (
        <div className="grid cols-2">
          <Field label="Plan artifact id"><TextInput mono value={g.planArtifact} onChange={(v) => set('planArtifact', v)} /></Field>
          <Field label="Files path" hint="e.g. tasks[].files"><TextInput mono value={g.filesPath} onChange={(v) => set('filesPath', v)} /></Field>
          <Field label="Always allowed (globs)"><ListEditor value={g.alwaysAllowed} onChange={(v) => set('alwaysAllowed', v)} /></Field>
          <Field label="Max files changed (optional)"><NumberInput value={g.maxFilesChanged ?? NaN} onChange={(v) => set('maxFilesChanged', Number.isFinite(v) ? v : undefined)} /></Field>
        </div>
      )}
      {g.type === 'json_assert' && (
        <div className="stack sm">
          <Field label="Artifact id"><TextInput mono value={g.artifact} onChange={(v) => set('artifact', v)} /></Field>
          <span className="label">Assertions</span>
          <span className="hint small muted">Path examples: <code>verdict</code>, <code>findings[?severity==blocker]</code>, <code>tasks[].files</code></span>
          {(g.assertions as any[]).map((a, i) => (
            <div key={i} className="grid cols-4" style={{ alignItems: 'end' }}>
              <Field label="Path"><TextInput mono value={a.path} onChange={(v) => set('assertions', g.assertions.map((x: any, j: number) => (j === i ? { ...x, path: v } : x)))} /></Field>
              <Field label="Op">
                <Select value={a.op} onChange={(v) => set('assertions', g.assertions.map((x: any, j: number) => (j === i ? { ...x, op: v } : x)))} options={['eq', 'neq', 'in', 'exists', 'count_eq', 'count_lte', 'count_gte'].map((o) => ({ value: o, label: o }))} />
              </Field>
              <Field label="Value (JSON)">
                <TextInput mono value={a.value === undefined ? '' : JSON.stringify(a.value)} onChange={(v) => { let parsed: unknown = v; try { parsed = JSON.parse(v); } catch { /* keep string */ } set('assertions', g.assertions.map((x: any, j: number) => (j === i ? { ...x, value: v === '' ? undefined : parsed } : x))); }} />
              </Field>
              <Field label="Message shown on failure"><TextInput value={a.message} onChange={(v) => set('assertions', g.assertions.map((x: any, j: number) => (j === i ? { ...x, message: v } : x)))} /></Field>
            </div>
          ))}
          <div><button className="btn sm" onClick={() => set('assertions', [...g.assertions, { path: '', op: 'eq', value: '', message: '' }])}>Add assertion</button></div>
        </div>
      )}
      {g.type === 'human_approval' && (
        <div className="grid cols-2">
          <Field label="Reviewer instructions"><TextArea rows={3} value={g.instructions} onChange={(v) => set('instructions', v)} /></Field>
          <Field label="Checklist" hint="The reviewer must tick every item before Approve unlocks."><ListEditor value={g.checklist} onChange={(v) => set('checklist', v)} mono={false} /></Field>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- editor */

export function OperationEdit() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ['operation', id], queryFn: () => api.get<OperationDoc>(`/operations/${id}`) });
  const skills = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const ops = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [draft, setDraft] = useState<Operation | null>(null);
  const [tab, setTab] = useState<'basics' | 'policy' | 'artifacts' | 'gates' | 'json'>('basics');
  const [json, setJson] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [instrView, setInstrView] = useState<'edit' | 'preview'>('edit');

  useEffect(() => {
    if (doc.data) setDraft(editable(doc.data) as Operation);
  }, [doc.data]);
  useEffect(() => {
    if (tab === 'json' && draft) setJson(JSON.stringify(draft, null, 2));
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['operation', id] });
    void qc.invalidateQueries({ queryKey: ['operations'] });
  };
  const save = useMutation({ mutationFn: () => api.put(`/operations/${id}`, draft), onSuccess: () => (toast('Operation saved'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const dup = useMutation({ mutationFn: () => api.post<OperationDoc>(`/operations/${id}/duplicate`), onSuccess: (o) => (refresh(), nav(`/operations/${o._id}`)), onError: (e: Error) => toast(e.message, 'error') });
  const reset = useMutation({ mutationFn: () => api.post(`/operations/${id}/reset`), onSuccess: () => (toast('Reset to built-in default'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const del = useMutation({ mutationFn: () => api.del(`/operations/${id}`), onSuccess: () => (toast('Deleted'), qc.invalidateQueries({ queryKey: ['operations'] }), nav('/operations')), onError: (e: Error) => toast(e.message, 'error') });
  const prev = useMutation({ mutationFn: () => api.post<{ system: string }>('/operations/preview', { operation: draft }), onSuccess: (r) => setPreview(r.system), onError: (e: Error) => toast(e.message, 'error') });

  if (!draft) return <p className="muted">Loading…</p>;
  const set = <K extends keyof Operation>(k: K, v: Operation[K]) => setDraft({ ...draft, [k]: v });
  const models = (settings.data?.models ?? []).filter((m) => m.provider === draft.provider);

  return (
    <div className="stack lg">
      <PageHead
        title={draft.name}
        sub={<span className="row"><span className="tag mono">{draft.key}</span>{draft.builtIn && <span className="tag">built-in</span>}{gateBadges(draft)}</span>}
        actions={
          <>
            <button className="btn" onClick={() => prev.mutate()}>Preview prompt</button>
            <button className="btn" onClick={() => dup.mutate()}>Duplicate</button>
            {draft.builtIn && <button className="btn" onClick={() => confirm('Discard your changes and restore the built-in definition?') && reset.mutate()}>Reset</button>}
            {!draft.builtIn && <button className="btn ghost danger" onClick={() => confirm('Delete this operation?') && del.mutate()}>Delete</button>}
            <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
          </>
        }
      />
      <Tabs
        tabs={[
          { id: 'basics', label: 'Instructions & model' },
          { id: 'policy', label: 'Guardrails' },
          { id: 'artifacts', label: `Artifacts (${draft.artifacts.length})` },
          { id: 'gates', label: `Gates (${draft.gates.length})` },
          { id: 'json', label: 'JSON' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'basics' && (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card title="Instructions" sub="Strict operating rules for this operation. Use MUST / MUST NOT. Injected after the harness contract.">
            <div className="stack">
              <div className="grid cols-2">
                <Field label="Name"><TextInput value={draft.name} onChange={(v) => set('name', v)} /></Field>
                <Field label="Key" hint="Referenced by pipelines"><TextInput mono value={draft.key} onChange={(v) => set('key', v)} /></Field>
              </div>
              <Field label="Description"><TextInput value={draft.description} onChange={(v) => set('description', v)} /></Field>
              <div className="row between">
                <span className="label">Instructions (markdown)</span>
                <Seg options={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]} value={instrView} onChange={setInstrView} />
              </div>
              {instrView === 'edit' ? <TextArea mono rows={18} value={draft.instructions} onChange={(v) => set('instructions', v)} /> : <div className="card card-pad"><Markdown>{draft.instructions}</Markdown></div>}
            </div>
          </Card>
          <div className="stack">
            <Card title="Model">
              <div className="stack">
                <div className="grid cols-2">
                  <Field label="Provider">
                    <Select
                      value={draft.provider}
                      onChange={(v) => {
                        // Keep the model only if it belongs to the new provider; otherwise pick its first catalog model.
                        const ids = (settings.data?.models ?? []).filter((m) => m.provider === v).map((m) => m.id);
                        setDraft({ ...draft, provider: v, model: ids.includes(draft.model) ? draft.model : (ids[0] ?? '') });
                      }}
                      options={(providers.data ?? []).map((p) => ({ value: p.id, label: `${p.label}${p.configured ? '' : ' (not configured)'}` }))}
                    />
                  </Field>
                  <Field label="Model" hint="From the model catalog in Settings, or type any id.">
                    <input className="input code" list="models" value={draft.model} onChange={(e) => set('model', e.target.value)} />
                    <datalist id="models">{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
                  </Field>
                </div>
                {settings.data && modelProblem(draft.provider, draft.model, settings.data.models) && (
                  <div className="callout warning small">{modelProblem(draft.provider, draft.model, settings.data.models)}</div>
                )}
                <Field label="Effort" hint="Reasoning depth for providers that support it. Higher costs more and is better for hard work.">
                  <Seg options={EFFORTS.map((e) => ({ id: e, label: e }))} value={draft.effort} onChange={(v) => set('effort', v)} />
                </Field>
              </div>
            </Card>
            <Card title="Skills" sub="Rule sets applied in this operation">
              <div className="stack sm">
                {(skills.data ?? []).map((s) => (
                  <Check key={s.slug} checked={draft.skills.includes(s.slug)} onChange={(on) => set('skills', on ? [...draft.skills, s.slug] : draft.skills.filter((x) => x !== s.slug))} label={<span><strong>{s.name}</strong> <span className="muted small">— {s.description}</span></span>} />
                ))}
              </div>
            </Card>
            <Card title="Inputs" sub="Artifacts from earlier stages injected as binding context. A missing required input blocks the stage.">
              <div className="stack sm">
                {draft.inputs.map((inp, i) => (
                  <div key={i} className="kv">
                    <input className="input code" value={inp.artifact} onChange={(e) => set('inputs', draft.inputs.map((x, j) => (j === i ? { ...x, artifact: e.target.value } : x)))} />
                    <Check checked={inp.required} onChange={(v) => set('inputs', draft.inputs.map((x, j) => (j === i ? { ...x, required: v } : x)))} label="Required" />
                    <button className="btn ghost sm danger" onClick={() => set('inputs', draft.inputs.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                ))}
                <div><button className="btn sm" onClick={() => set('inputs', [...draft.inputs, { artifact: '', required: true }])}>Add input</button></div>
              </div>
            </Card>
            <Card title="Retries, rewinds and post-actions">
              <div className="stack">
                <div className="grid cols-3">
                  <Field label="Max attempts"><NumberInput value={draft.maxAttempts} onChange={(v) => set('maxAttempts', v)} min={1} /></Field>
                  <Field label="Rewind to" hint="Target for gates set to 'rewind'">
                    <Select value={draft.rewindTo ?? ''} onChange={(v) => set('rewindTo', v || undefined)} placeholder="(none)" options={(ops.data ?? []).filter((o) => o.key !== draft.key).map((o) => ({ value: o.key, label: o.name }))} />
                  </Field>
                  <Field label="Max rewinds"><NumberInput value={draft.maxRewinds} onChange={(v) => set('maxRewinds', v)} min={0} /></Field>
                </div>
                <div className="row">
                  <Check checked={draft.postActions.commit} onChange={(v) => set('postActions', { ...draft.postActions, commit: v })} label="Commit stage output to the run branch" />
                  <Check checked={draft.postActions.push} onChange={(v) => set('postActions', { ...draft.postActions, push: v })} label="Push branch after approval" />
                  <Check checked={draft.postActions.openPullRequest} onChange={(v) => set('postActions', { ...draft.postActions, openPullRequest: v, push: v || draft.postActions.push })} label="Open GitHub PR after approval" />
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'policy' && (
        <Card title="Policy guardrails" sub="Checked on every tool call. Any violation halts the stage immediately and blocks the run for a human. Pipeline-level forbidden paths and denied commands are always added on top.">
          <PolicyEditor value={draft.policy} onChange={(p) => set('policy', p)} />
        </Card>
      )}

      {tab === 'artifacts' && (
        <div className="stack">
          <p className="small ink-2">Artifacts are the machine-readable handoff between stages. The agent must write each one exactly; the artifacts gate validates them and later stages receive them as binding inputs.</p>
          {draft.artifacts.map((a, i) => (
            <ArtifactEditor key={i} value={a} onChange={(v) => set('artifacts', draft.artifacts.map((x, j) => (j === i ? v : x)))} onRemove={() => set('artifacts', draft.artifacts.filter((_, j) => j !== i))} />
          ))}
          <div>
            <button className="btn" onClick={() => set('artifacts', [...draft.artifacts, { id: `artifact${draft.artifacts.length + 1}`, path: 'output.md', format: 'markdown', description: '', requiredHeadings: [], requiredPatterns: [], minChars: 0, rejectPlaceholders: true, captureToKnowledge: false }])}>
              Add artifact
            </button>
          </div>
        </div>
      )}

      {tab === 'gates' && (
        <div className="stack">
          <p className="small ink-2">Gates run after the agent calls finish, in this order: artifacts → JSON assertions → diff scope → commands → human approval. A human gate only opens once every automated gate passes.</p>
          {draft.gates.map((g, i) => (
            <GateEditor key={i} value={g} artifactIds={draft.artifacts.map((a) => a.id)} onChange={(v) => set('gates', draft.gates.map((x, j) => (j === i ? v : x)))} onRemove={() => set('gates', draft.gates.filter((_, j) => j !== i))} />
          ))}
          <div className="row">
            {(Object.keys(GATE_LABEL) as Gate['type'][]).map((t) => (
              <button
                key={t}
                className="btn sm"
                onClick={() => {
                  const base = { id: `${t.replace('_', '-')}-${draft.gates.length + 1}`, name: GATE_LABEL[t], enabled: true, onFail: 'retry' as const };
                  const extra: Record<Gate['type'], object> = {
                    artifacts: {},
                    command: { check: 'test', required: true, timeoutSeconds: 600, expectExitCode: 0 },
                    diff_scope: { planArtifact: 'plan_json', filesPath: 'tasks[].files', alwaysAllowed: [] },
                    json_assert: { artifact: draft.artifacts[0]?.id ?? '', assertions: [{ path: 'verdict', op: 'eq', value: 'approve', message: 'Verdict must be approve' }] },
                    human_approval: { instructions: 'Review the stage output before the pipeline continues.', checklist: [] },
                  };
                  set('gates', [...draft.gates, { ...base, type: t, ...extra[t] } as Gate]);
                }}
              >
                + {GATE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'json' && (
        <Card title="Raw definition" sub="Full control. Apply, then Save. The server validates everything.">
          <TextArea mono rows={30} value={json} onChange={setJson} />
          <div className="row end" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() => {
                try {
                  setDraft(JSON.parse(json));
                  toast('Applied — remember to save');
                } catch (e) {
                  toast(`Invalid JSON: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Apply JSON
            </button>
          </div>
        </Card>
      )}

      {preview !== null && (
        <Modal wide title="System prompt preview" onClose={() => setPreview(null)}>
          <p className="small ink-2" style={{ marginBottom: 12 }}>Exactly what the agent receives as its contract (with placeholder repo checks and knowledge).</p>
          <Markdown>{preview}</Markdown>
        </Modal>
      )}
    </div>
  );
}
