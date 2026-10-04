import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInput } from '@harness/shared';
import { ago, api, editable, type ScheduleDoc } from '../api';
import { Card, Check, Empty, Field, Modal, PageHead, Select, TextArea, TextInput, useToast } from '../components/ui';

const PRESETS = [
  { cron: '0 22 * * 1-5', label: 'Weeknights 22:00' },
  { cron: '0 2 * * *', label: 'Every night 02:00' },
  { cron: '0 6 * * 1', label: 'Mondays 06:00' },
  { cron: '0 */6 * * *', label: 'Every 6 hours' },
];

export function Schedules() {
  const toast = useToast();
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: api.schedules });
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const [edit, setEdit] = useState<{ id?: string; d: ScheduleInput } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const save = useMutation({
    mutationFn: () => (edit!.id ? api.put(`/schedules/${edit!.id}`, edit!.d) : api.post('/schedules', edit!.d)),
    onSuccess: () => (toast('Schedule saved'), refresh(), setEdit(null)),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const runNow = useMutation({ mutationFn: (id: string) => api.post(`/schedules/${id}/run-now`), onSuccess: () => (toast('Run created'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/schedules/${id}`), onSuccess: () => (refresh(), setEdit(null)) });
  const toggle = useMutation({ mutationFn: (s: ScheduleDoc) => api.put(`/schedules/${s._id}`, { ...editable(s), nextRunAt: undefined, lastRunAt: undefined, lastRunId: undefined, lastError: undefined, enabled: !s.enabled }), onSuccess: refresh, onError: (e: Error) => toast(e.message, 'error') });
  const set = <K extends keyof ScheduleInput>(k: K, v: ScheduleInput[K]) => setEdit((e) => (e ? { ...e, d: { ...e.d, [k]: v } } : e));
  const name = (list: { _id: string; name: string }[] | undefined, id: string) => list?.find((x) => x._id === id)?.name ?? '—';

  return (
    <div className="stack lg">
      <PageHead
        title="Schedules"
        sub="The 24-hour sprint: queue recurring or overnight work. Agents execute on schedule; every gate still applies, and human gates wait for you in the morning."
        actions={
          <button className="btn primary" disabled={!repos.data?.length || !pipelines.data?.length} onClick={() => setEdit({ d: { name: '', repoId: repos.data?.[0]?._id ?? '', pipelineId: pipelines.data?.[0]?._id ?? '', task: '', cron: PRESETS[0].cron, enabled: true } })}>
            New schedule
          </button>
        }
      />
      <Card pad={false}>
        {schedules.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Cron</th>
                <th>Next run</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((s) => (
                <tr key={s._id}>
                  <td>
                    <strong>{s.name}</strong>
                    <div className="tiny muted">{name(repos.data, s.repoId)} · {name(pipelines.data, s.pipelineId)}</div>
                  </td>
                  <td><code>{s.cron}</code></td>
                  <td className="small">{s.enabled ? (s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—') : <span className="pill">⏸ Paused</span>}</td>
                  <td className="small">
                    {s.lastRunId ? <Link to={`/runs/${s.lastRunId}`}>{ago(s.lastRunAt)}</Link> : '—'}
                    {s.lastError && <div className="tiny" style={{ color: 'var(--critical-ink)' }}>{s.lastError}</div>}
                  </td>
                  <td className="right">
                    <div className="row end">
                      <button className="btn sm" onClick={() => toggle.mutate(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                      <button className="btn sm" onClick={() => runNow.mutate(s._id)}>Run now</button>
                      <button className="btn sm" onClick={() => setEdit({ id: s._id, d: { name: s.name, repoId: s.repoId, pipelineId: s.pipelineId, task: s.task, cron: s.cron, enabled: s.enabled } })}>Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No schedules">Use schedules for recurring work (dependency hygiene, flaky-test triage, docs refresh) or to run approved plans overnight.</Empty>
        )}
      </Card>
      {edit && (
        <Modal
          title={edit.id ? 'Edit schedule' : 'New schedule'}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && <button className="btn danger" onClick={() => confirm('Delete this schedule?') && del.mutate(edit.id!)}>Delete</button>}
              <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
            </>
          }
        >
          <div className="stack">
            <Field label="Name"><TextInput value={edit.d.name} onChange={(v) => set('name', v)} placeholder="Nightly dependency hygiene" /></Field>
            <div className="grid cols-2">
              <Field label="Repository"><Select value={edit.d.repoId} onChange={(v) => set('repoId', v)} options={(repos.data ?? []).map((r) => ({ value: r._id, label: r.name }))} /></Field>
              <Field label="Pipeline"><Select value={edit.d.pipelineId} onChange={(v) => set('pipelineId', v)} options={(pipelines.data ?? []).map((p) => ({ value: p._id, label: p.name }))} /></Field>
            </div>
            <Field label="Task"><TextArea rows={5} value={edit.d.task} onChange={(v) => set('task', v)} /></Field>
            <Field label="Cron (server local time)" hint="minute hour day-of-month month day-of-week">
              <TextInput mono value={edit.d.cron} onChange={(v) => set('cron', v)} />
            </Field>
            <div className="row">
              {PRESETS.map((p) => (
                <button key={p.cron} className="btn sm" onClick={() => set('cron', p.cron)}>{p.label}</button>
              ))}
            </div>
            <Check checked={edit.d.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
          </div>
        </Modal>
      )}
    </div>
  );
}
