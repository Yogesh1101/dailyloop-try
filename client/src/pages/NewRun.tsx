import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card, Field, PageHead, Seg, Select, TextArea, TextInput, useToast } from '../components/ui';

export function NewRun() {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const operations = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [repoId, setRepoId] = useState(params.get('repo') ?? '');
  const [pipelineId, setPipelineId] = useState(params.get('pipeline') ?? '');
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [when, setWhen] = useState<'now' | 'tonight' | 'at'>('now');
  const [at, setAt] = useState('');

  useEffect(() => {
    if (!repoId && repos.data?.length) setRepoId(repos.data[0]._id);
  }, [repos.data, repoId]);
  useEffect(() => {
    if (!pipelineId && pipelines.data?.length) setPipelineId(pipelines.data[0]._id);
  }, [pipelines.data, pipelineId]);

  const pipeline = pipelines.data?.find((p) => p._id === pipelineId);
  const stages = useMemo(
    () => (pipeline?.stages ?? []).map((s) => ({ s, op: operations.data?.find((o) => o.key === s.operationKey) })),
    [pipeline, operations.data],
  );

  const create = useMutation({
    mutationFn: () =>
      api.createRun({ repoId, pipelineId, title: title || undefined, task, when, scheduledFor: when === 'at' && at ? new Date(at).toISOString() : undefined }),
    onSuccess: (run) => {
      toast(when === 'now' ? 'Run queued' : 'Run scheduled');
      nav(`/runs/${run._id}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (repos.data && !repos.data.length) {
    return (
      <div className="stack lg">
        <PageHead title="New run" />
        <div className="callout warning">
          <h3>No repositories yet</h3>
          <p className="small">
            <Link to="/repos">Add a repository</Link> first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack lg">
      <PageHead title="New run" sub="Describe the outcome you want. The pipeline decides how the agents get there and where humans must approve." />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title="Task">
          <div className="stack">
            <div className="grid cols-2">
              <Field label="Repository">
                <Select value={repoId} onChange={setRepoId} options={(repos.data ?? []).map((r) => ({ value: r._id, label: r.name }))} />
              </Field>
              <Field label="Pipeline">
                <Select value={pipelineId} onChange={setPipelineId} options={(pipelines.data ?? []).map((p) => ({ value: p._id, label: p.name }))} />
              </Field>
            </div>
            <Field label="Title" hint="Optional. Defaults to the first line of the task. Used for the branch name.">
              <TextInput value={title} onChange={setTitle} placeholder="Add rate limiting to the login endpoint" />
            </Field>
            <Field label="Task" hint="Be specific about the outcome, constraints and what is out of scope. At least 10 characters.">
              <TextArea rows={10} value={task} onChange={setTask} placeholder={'What should change, and why?\n\nConstraints:\n- …\n\nOut of scope:\n- …'} />
            </Field>
            <Field label="When">
              <Seg
                options={[
                  { id: 'now', label: 'Now' },
                  { id: 'tonight', label: `Tonight (${settings.data?.nightlyStartTime ?? '22:00'})` },
                  { id: 'at', label: 'At…' },
                ]}
                value={when}
                onChange={setWhen}
              />
            </Field>
            {when === 'at' && (
              <Field label="Start at">
                <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </Field>
            )}
            <div className="row end">
              <button className="btn primary" disabled={!repoId || !pipelineId || task.trim().length < 10 || create.isPending} onClick={() => create.mutate()}>
                {when === 'now' ? 'Start run' : 'Schedule run'}
              </button>
            </div>
          </div>
        </Card>
        <Card title="What will happen" sub={pipeline?.description}>
          <ol className="stack sm" style={{ margin: 0, paddingLeft: 18 }}>
            {stages.map(({ s, op }, i) => {
              const human = op?.gates.some((g) => g.type === 'human_approval' && g.enabled);
              const auto = op?.gates.filter((g) => g.type !== 'human_approval' && g.enabled) ?? [];
              return (
                <li key={i}>
                  <div className="row">
                    <strong>{op?.name ?? s.operationKey}</strong>
                    <span className="tag mono">{s.overrides?.provider ?? op?.provider}/{s.overrides?.model ?? op?.model}</span>
                    {human && <span className="pill warning">✋ Human gate</span>}
                  </div>
                  <div className="tiny muted">
                    {auto.length ? `Gates: ${auto.map((g) => g.name).join(', ')}` : 'No automated gates'}
                    {op?.rewindTo ? ` · failures rewind to ${op.rewindTo}` : ''}
                  </div>
                </li>
              );
            })}
          </ol>
          {pipeline && (
            <p className="small muted" style={{ marginTop: 12 }}>
              Run budget {`$${pipeline.maxRunCostUsd}`}. Work happens on a new branch in an isolated worktree; your checkout is never modified.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
