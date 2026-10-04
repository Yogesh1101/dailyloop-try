import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelProblem, type GateResult, type HumanApprovalGate, type RunEvent, type RunStage } from '@harness/shared';
import { ago, api, compact, usd, type Run } from '../api';
import { useRunStream } from '../hooks';
import { Card, Check, Empty, Field, JsonView, Markdown, Modal, PageHead, Seg, Select, StatusPill, Tabs, TextArea, useToast } from '../components/ui';

/* ------------------------------------------------------------------ pieces */

function GateList({ results }: { results: GateResult[] }) {
  const attempts = [...new Set(results.map((r) => r.attempt))].sort((a, b) => b - a);
  if (!results.length) return <p className="muted small">No gate has run yet.</p>;
  return (
    <div className="stack">
      {attempts.map((a, idx) => (
        <details key={a} open={idx === 0}>
          <summary className="section-title" style={{ cursor: 'pointer' }}>
            Attempt {a} — {results.filter((r) => r.attempt === a && r.passed).length}/{results.filter((r) => r.attempt === a).length} passed
          </summary>
          {results
            .filter((r) => r.attempt === a)
            .map((r, i) => (
              <div className="gate" key={`${r.gateId}-${i}`}>
                <span className={`icon ${r.passed ? 'ok' : 'fail'}`} aria-label={r.passed ? 'passed' : 'failed'}>
                  {r.passed ? '✓' : '✕'}
                </span>
                <div>
                  <div className="row">
                    <strong>{r.name}</strong>
                    <span className="tag mono">{r.type}</span>
                    <span className="tiny muted">{ago(r.at)}</span>
                  </div>
                  <div className="small ink-2">{r.message}</div>
                  {r.output && <pre className="out">{r.output}</pre>}
                </div>
              </div>
            ))}
        </details>
      ))}
    </div>
  );
}

function ArtifactsView({ stage }: { stage: RunStage }) {
  const [sel, setSel] = useState(stage.artifacts[0]?.id ?? '');
  const [raw, setRaw] = useState(false);
  useEffect(() => setSel(stage.artifacts[0]?.id ?? ''), [stage.operationKey, stage.artifacts]);
  const a = stage.artifacts.find((x) => x.id === sel);
  if (!stage.artifacts.length) return <Empty title="No artifacts yet">Artifacts appear after the agent calls finish and gates evaluate.</Empty>;
  return (
    <div className="stack">
      <div className="row between">
        <Seg options={stage.artifacts.map((x) => ({ id: x.id, label: `${x.valid ? '✓' : '✕'} ${x.path.split('/').pop()}` }))} value={sel} onChange={setSel} />
        {a?.format === 'markdown' && <Check checked={raw} onChange={setRaw} label="Show source" />}
      </div>
      {a && (
        <>
          <div className="row">
            <code>{a.path}</code>
            {a.valid ? <span className="pill good">✓ Satisfies contract</span> : <span className="pill critical">✕ Violates contract</span>}
          </div>
          {!a.valid && (
            <div className="callout critical">
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {a.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="card card-pad">
            {a.format === 'json' ? <JsonView value={(() => { try { return JSON.parse(a.content); } catch { return a.content; } })()} /> : raw ? <pre className="small">{a.content}</pre> : <Markdown>{a.content || '_(empty)_'}</Markdown>}
          </div>
        </>
      )}
    </div>
  );
}

function PromptView({ runId, index }: { runId: string; index: number }) {
  const q = useQuery({ queryKey: ['prompt', runId, index], queryFn: () => api.get<{ system: string; brief: string }>(`/runs/${runId}/stages/${index}/prompt`) });
  const [part, setPart] = useState<'system' | 'brief'>('system');
  if (!q.data) return <p className="muted small">Loading…</p>;
  return (
    <div className="stack">
      <p className="small ink-2">Exactly what the agent receives for this stage: the system contract (identical on every turn, so it is prompt-cached) and the stage brief.</p>
      <Seg options={[{ id: 'system', label: 'System contract' }, { id: 'brief', label: 'Stage brief' }]} value={part} onChange={setPart} />
      <div className="card card-pad">
        <Markdown>{part === 'system' ? q.data.system : q.data.brief}</Markdown>
      </div>
    </div>
  );
}

function EventLog({ events }: { events: RunEvent[] }) {
  if (!events.length) return <Empty title="No activity yet" />;
  return (
    <div className="log" role="log">
      {events.map((e, i) => (
        <div key={e._id ?? i} className={`log-row ${e.level}`}>
          <span className="k">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className="k">{e.kind}</span>
          {e.data !== undefined && e.data !== null ? (
            <details>
              <summary className="m">{e.message}</summary>
              <pre className="out">{typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)}</pre>
            </details>
          ) : (
            <span className="m">{e.message}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function DiffView({ runId, status }: { runId: string; status: string }) {
  const q = useQuery({ queryKey: ['diff', runId, status], queryFn: () => api.get<{ stat: string; patch: string; untracked: string[]; note?: string }>(`/runs/${runId}/diff`) });
  if (!q.data) return <p className="muted small">Loading…</p>;
  if (q.data.note) return <Empty title={q.data.note} />;
  const lines = q.data.patch.split('\n');
  return (
    <div className="stack">
      <pre className="out">{q.data.stat || 'No changes against the base commit.'}</pre>
      {q.data.untracked.length > 0 && <p className="small">Untracked: {q.data.untracked.map((f) => <code key={f}>{f}</code>)}</p>}
      {q.data.patch && (
        <div className="card diff">
          {lines.map((l, i) => (
            <div key={i} className={l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>
              {l || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- approval */

function ApprovalPanel({ run, gate }: { run: Run; gate?: HumanApprovalGate }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [checked, setChecked] = useState<boolean[]>([]);
  const [notes, setNotes] = useState('');
  const [resume, setResume] = useState<'now' | 'tonight'>('now');
  const stage = run.stages[run.currentStage];
  const checklist = gate?.checklist ?? [];
  useEffect(() => setChecked(checklist.map(() => false)), [run._id, run.currentStage, stage?.attempts]); // eslint-disable-line react-hooks/exhaustive-deps
  const allChecked = checked.length === checklist.length && checked.every(Boolean);
  const isLast = run.currentStage === run.stages.length - 1;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['run', run._id] });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
  };
  const approve = useMutation({
    mutationFn: () => api.post(`/runs/${run._id}/approve`, { notes, resume }),
    onSuccess: () => {
      toast(isLast ? 'Approved — run complete' : resume === 'tonight' ? 'Approved — continues tonight' : 'Approved — next stage queued');
      setNotes('');
      done();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/runs/${run._id}/reject`, { feedback: notes }),
    onSuccess: () => {
      toast('Rejected — the stage re-runs with your feedback');
      setNotes('');
      done();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="callout warning">
      <div className="stack">
        <div>
          <h3>✋ Human gate: {gate?.name ?? 'Approval'} — {stage?.name}</h3>
          <p className="small">{gate?.instructions}</p>
        </div>
        {checklist.length > 0 && (
          <div className="stack sm">
            <span className="label">Confirm each item before approving</span>
            {checklist.map((c, i) => (
              <Check key={i} checked={!!checked[i]} onChange={(v) => setChecked((xs) => xs.map((x, j) => (j === i ? v : x)))} label={c} />
            ))}
          </div>
        )}
        <Field label="Notes" hint="On approve: binding decisions every later stage must follow. On reject: required feedback the agent must address.">
          <TextArea rows={3} value={notes} onChange={setNotes} placeholder="e.g. Q1: support floats. Q2: keep the public API unchanged." />
        </Field>
        <div className="row between">
          {!isLast ? (
            <Seg options={[{ id: 'now', label: 'Continue now' }, { id: 'tonight', label: 'Continue tonight' }]} value={resume} onChange={setResume} />
          ) : (
            <span className="small">Final gate{stage?.snapshot.postActions.push || stage?.snapshot.postActions.openPullRequest ? ': approving pushes the branch / opens a PR.' : '.'}</span>
          )}
          <div className="row">
            <button className="btn danger" disabled={!notes.trim() || reject.isPending} onClick={() => reject.mutate()} title={!notes.trim() ? 'Write feedback to reject' : undefined}>
              Reject with feedback
            </button>
            <button className="btn good" disabled={!allChecked || approve.isPending} onClick={() => approve.mutate()} title={!allChecked ? 'Tick every checklist item first' : undefined}>
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BlockedPanel({ run }: { run: Run }) {
  const toast = useToast();
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const stage = run.stages[run.currentStage];
  const [guidance, setGuidance] = useState('');
  const [switching, setSwitching] = useState(/model|quota|provider/i.test(stage?.error ?? ''));
  const [provider, setProvider] = useState(stage?.snapshot.provider ?? '');
  const [model, setModel] = useState(stage?.snapshot.model ?? '');
  const [scope, setScope] = useState<'stage' | 'remaining'>('remaining');
  const catalog = settings.data?.models ?? [];
  const problem = switching && settings.data ? modelProblem(provider, model, catalog) : null;
  const retry = useMutation({
    mutationFn: () => api.post(`/runs/${run._id}/retry`, { feedback: guidance, ...(switching ? { provider, model, scope } : {}) }),
    onSuccess: () => {
      toast(switching ? `Retry queued on ${provider}/${model}` : 'Retry queued');
      setGuidance('');
      void qc.invalidateQueries({ queryKey: ['run', run._id] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="callout critical">
      <div className="stack">
        <div>
          <h3>{run.status === 'error' ? 'Run error' : stage?.violation ? 'Halted by a policy violation' : 'Blocked — human action required'}</h3>
          <p className="small">{run.statusMessage}</p>
        </div>
        {stage?.violation && (
          <div className="small">
            Rule <code>{stage.violation.rule}</code>: {stage.violation.detail}
            {stage.violation.input && <pre className="out">{stage.violation.input}</pre>}
          </div>
        )}
        <Field label="Guidance for the retry (optional)" hint="Fix the cause first (repo checks, budgets, provider keys, operation config), then retry the current stage.">
          <TextArea rows={2} value={guidance} onChange={setGuidance} />
        </Field>
        <div className="stack sm">
          <Check
            checked={switching}
            onChange={setSwitching}
            label={
              <span>
                Switch model before retrying <span className="muted small">(currently <code>{stage?.snapshot.provider}/{stage?.snapshot.model || '(none)'}</code>)</span>
              </span>
            }
          />
          {switching && (
            <div className="grid cols-3" style={{ gap: 8 }}>
              <Select
                value={provider}
                onChange={(v) => {
                  setProvider(v);
                  setModel(catalog.find((m) => m.provider === v)?.id ?? '');
                }}
                options={(providers.data ?? []).map((p) => ({ value: p.id, label: `${p.label}${p.configured ? '' : ' (not configured)'}` }))}
              />
              <div>
                <input className="input code" list="retry-models" placeholder="Model id" value={model} onChange={(e) => setModel(e.target.value)} />
                <datalist id="retry-models">
                  {catalog.filter((m) => m.provider === provider).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </datalist>
              </div>
              <Seg options={[{ id: 'remaining', label: 'This and later stages' }, { id: 'stage', label: 'This stage only' }]} value={scope} onChange={setScope} />
            </div>
          )}
          {problem && <span className="small">{problem}</span>}
        </div>
        <div className="row end">
          <button className="btn primary" disabled={retry.isPending || !!problem} onClick={() => retry.mutate()}>
            Retry {stage?.name}
          </button>
        </div>
      </div>
    </div>
  );
}

function RewindModal({ run, onClose }: { run: Run; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const max = Math.min(run.currentStage, run.stages.length - 1);
  const [index, setIndex] = useState(String(Math.max(0, max - 1)));
  const [feedback, setFeedback] = useState('');
  const rewind = useMutation({
    mutationFn: () => api.post(`/runs/${run._id}/rewind`, { stageIndex: Number(index), feedback }),
    onSuccess: () => {
      toast('Rewound');
      void qc.invalidateQueries({ queryKey: ['run', run._id] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Modal
      title="Send work back to an earlier stage"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!feedback.trim() || rewind.isPending} onClick={() => rewind.mutate()}>
          Rewind
        </button>
      }
    >
      <div className="stack">
        <Field label="Stage">
          <Select value={index} onChange={setIndex} options={run.stages.slice(0, max + 1).map((s, i) => ({ value: String(i), label: `${i + 1}. ${s.name}` }))} />
        </Field>
        <Field label="What must change" hint="Required. The stage re-runs with this feedback; every later stage re-runs after it.">
          <TextArea rows={5} value={feedback} onChange={setFeedback} />
        </Field>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------- page */

export function RunDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.run(id), refetchInterval: (q) => (q.state.data?.status === 'running' ? 5000 : false) });
  const initialEvents = useQuery({ queryKey: ['events', id], queryFn: () => api.events(id) });
  const [live, setLive] = useState<RunEvent[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'overview' | 'artifacts' | 'prompt' | 'contract' | 'log'>('overview');
  const [view, setView] = useState<'stage' | 'diff' | 'activity' | 'task'>('stage');
  const [rewindOpen, setRewindOpen] = useState(false);

  useEffect(() => setLive([]), [initialEvents.data]);
  useRunStream(id, (e) => setLive((xs) => [...xs, e]));
  const events = useMemo(() => {
    const seen = new Set((initialEvents.data ?? []).map((e) => e._id));
    return [...(initialEvents.data ?? []), ...live.filter((e) => !e._id || !seen.has(e._id))];
  }, [initialEvents.data, live]);

  const r = run.data;
  useEffect(() => {
    if (r && selected === null) setSelected(Math.min(r.currentStage, r.stages.length - 1));
  }, [r, selected]);

  const act = useMutation({
    mutationFn: (action: 'cancel' | 'cleanup') => api.post(`/runs/${id}/${action}`),
    onSuccess: (_d, action) => {
      toast(action === 'cancel' ? 'Cancelled' : 'Worktree removed (branch kept)');
      void qc.invalidateQueries({ queryKey: ['run', id] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/runs/${id}`),
    onSuccess: () => {
      toast('Run deleted');
      nav('/runs');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (run.error) return <Empty title="Run not found" />;
  if (!r || selected === null) return <p className="muted">Loading…</p>;
  const stage = r.stages[selected];
  const humanGate = r.stages[r.currentStage]?.snapshot.gates.find((g): g is HumanApprovalGate => g.type === 'human_approval' && g.enabled);
  const stageEvents = events.filter((e) => e.stageIndex === selected);
  const scheduled = r.status === 'queued' && r.scheduledFor && new Date(r.scheduledFor) > new Date();

  return (
    <div className="stack lg">
      <PageHead
        title={r.title}
        sub={
          <span className="row">
            <StatusPill status={r.status} scheduled={!!scheduled} />
            <span>{r.statusMessage}</span>
          </span>
        }
        actions={
          <>
            {['awaiting_approval', 'blocked', 'completed', 'error', 'cancelled'].includes(r.status) && r.currentStage > 0 && (
              <button className="btn" onClick={() => setRewindOpen(true)}>Rewind…</button>
            )}
            {['queued', 'running', 'awaiting_approval', 'blocked'].includes(r.status) && (
              <button className="btn danger" onClick={() => confirm('Cancel this run?') && act.mutate('cancel')}>Cancel</button>
            )}
            {r.worktreePath && ['completed', 'cancelled', 'error', 'blocked'].includes(r.status) && (
              <button className="btn" onClick={() => act.mutate('cleanup')}>Remove worktree</button>
            )}
            {!['running', 'queued'].includes(r.status) && (
              <button className="btn ghost danger" onClick={() => confirm('Delete this run and its audit log? The branch is kept.') && del.mutate()}>Delete</button>
            )}
          </>
        }
      />

      <div className="grid cols-4">
        <div className="card stat">
          <div className="label">Repository</div>
          <div className="value" style={{ fontSize: 16 }}>{r.repoName}</div>
          <div className="sub mono truncate" title={r.branch}>{r.branch ?? 'branch not created yet'}</div>
        </div>
        <div className="card stat">
          <div className="label">Pipeline</div>
          <div className="value" style={{ fontSize: 16 }}>{r.pipeline.name}</div>
          <div className="sub">Stage {Math.min(r.currentStage + 1, r.stages.length)} of {r.stages.length}</div>
        </div>
        <div className="card stat">
          <div className="label">Cost</div>
          <div className="value">{usd(r.usage.costUsd)}</div>
          <div className="sub">of {usd(r.pipeline.maxRunCostUsd)} run budget · {compact(r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens)} tokens</div>
        </div>
        <div className="card stat">
          <div className="label">{scheduled ? 'Scheduled for' : 'Started'}</div>
          <div className="value" style={{ fontSize: 16 }}>{scheduled ? new Date(r.scheduledFor!).toLocaleString() : r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</div>
          <div className="sub">{r.pullRequestUrl ? <a href={r.pullRequestUrl} target="_blank" rel="noreferrer">Pull request ↗</a> : r.baseCommit ? <>base <code>{r.baseCommit.slice(0, 10)}</code></> : 'not started'}</div>
        </div>
      </div>

      {r.status === 'awaiting_approval' && <ApprovalPanel run={r} gate={humanGate} />}
      {(r.status === 'blocked' || r.status === 'error') && <BlockedPanel run={r} />}

      <Tabs
        tabs={[
          { id: 'stage', label: 'Stages' },
          { id: 'diff', label: 'Diff' },
          { id: 'activity', label: `Activity (${events.length})` },
          { id: 'task', label: 'Task & decisions' },
        ]}
        value={view}
        onChange={setView}
      />

      {view === 'stage' && (
        <div className="stack">
          <div className="stepper">
            {r.stages.map((s, i) => (
              <button key={i} className={`step ${i === selected ? 'selected' : ''}`} onClick={() => setSelected(i)}>
                <span className="n">
                  {i + 1}
                  {i === r.currentStage && r.status !== 'completed' ? ' · current' : ''}
                </span>
                <span className="name">{s.name}</span>
                <StatusPill status={s.status} kind="stage" />
              </button>
            ))}
          </div>
          <Card
            title={`${stage.name}`}
            sub={`${stage.snapshot.provider}/${stage.snapshot.model} · effort ${stage.snapshot.effort} · ${stage.attempts} attempt(s)${stage.rewinds ? ` · ${stage.rewinds} rewind(s)` : ''} · ${usd(stage.usage.costUsd)}`}
          >
            <Tabs
              tabs={[
                { id: 'overview', label: 'Gates' },
                { id: 'artifacts', label: `Artifacts (${stage.artifacts.length})` },
                { id: 'prompt', label: 'Prompt' },
                { id: 'contract', label: 'Contract' },
                { id: 'log', label: `Log (${stageEvents.length})` },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === 'overview' && (
              <div className="stack">
                {stage.summary && (
                  <div>
                    <div className="section-title">Agent summary</div>
                    <Markdown>{stage.summary}</Markdown>
                  </div>
                )}
                {stage.feedback && (
                  <div className="callout info">
                    <h3>Feedback queued for the next attempt</h3>
                    <Markdown>{stage.feedback}</Markdown>
                  </div>
                )}
                {stage.approval && (
                  <div className={`callout ${stage.approval.decision === 'approved' ? 'good' : 'warning'}`}>
                    <h3>{stage.approval.decision === 'approved' ? '✓ Approved' : '✕ Rejected'} {ago(stage.approval.at)}</h3>
                    {stage.approval.notes && <p className="small">{stage.approval.notes}</p>}
                  </div>
                )}
                <GateList results={stage.gateResults} />
              </div>
            )}
            {tab === 'artifacts' && <ArtifactsView stage={stage} />}
            {tab === 'prompt' && <PromptView runId={r._id} index={selected} />}
            {tab === 'contract' && (
              <div className="stack">
                <p className="small ink-2">The operation configuration frozen into this run at creation. Later edits to the operation do not affect it.</p>
                <JsonView value={{ policy: stage.snapshot.policy, inputs: stage.snapshot.inputs, artifacts: stage.snapshot.artifacts, gates: stage.snapshot.gates, maxAttempts: stage.snapshot.maxAttempts, rewindTo: stage.snapshot.rewindTo, postActions: stage.snapshot.postActions, skills: stage.skills.map((s) => s.slug) }} />
              </div>
            )}
            {tab === 'log' && <EventLog events={stageEvents} />}
          </Card>
        </div>
      )}
      {view === 'diff' && <DiffView runId={r._id} status={`${r.status}-${r.currentStage}`} />}
      {view === 'activity' && (
        <Card pad>
          <EventLog events={events} />
        </Card>
      )}
      {view === 'task' && (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card title="Task">
            <Markdown>{r.task}</Markdown>
          </Card>
          <Card title="Binding human decisions" sub="Recorded at approval gates; injected into every later stage">
            {r.humanNotes.length ? (
              <ul className="stack sm" style={{ margin: 0, paddingLeft: 18 }}>
                {r.humanNotes.map((n, i) => (
                  <li key={i}>
                    <span className="tag mono">{n.stageKey}</span> {n.notes} <span className="tiny muted">{ago(n.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None yet.</p>
            )}
            <hr />
            <p className="small">
              Pipeline snapshot: <Link to={`/pipelines/${r.pipeline.pipelineId}`}>{r.pipeline.name}</Link> · knowledge capture {r.pipeline.captureKnowledge ? 'on' : 'off'}
            </p>
          </Card>
        </div>
      )}
      {rewindOpen && <RewindModal run={r} onClose={() => setRewindOpen(false)} />}
    </div>
  );
}
