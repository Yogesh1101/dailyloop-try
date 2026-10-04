import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Skill } from '@harness/shared';
import { api, editable, type SkillDoc } from '../api';
import { Card, Empty, Field, ListEditor, Markdown, Modal, PageHead, Seg, TextArea, TextInput, useToast } from '../components/ui';

const BLANK: Skill = { slug: '', name: '', description: '', instructions: '', tags: [], builtIn: false };

export function Skills() {
  const toast = useToast();
  const qc = useQueryClient();
  const skills = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const ops = useQuery({ queryKey: ['operations'], queryFn: api.operations });
  const [edit, setEdit] = useState<{ id?: string; draft: Skill } | null>(null);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const done = (msg: string) => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: ['skills'] });
  };
  const save = useMutation({
    mutationFn: () => (edit!.id ? api.put(`/skills/${edit!.id}`, edit!.draft) : api.post('/skills', edit!.draft)),
    onSuccess: () => {
      done('Skill saved');
      setEdit(null);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const reset = useMutation({ mutationFn: (id: string) => api.post(`/skills/${id}/reset`), onSuccess: () => (done('Reset to default'), setEdit(null)), onError: (e: Error) => toast(e.message, 'error') });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/skills/${id}`), onSuccess: () => (done('Deleted'), setEdit(null)), onError: (e: Error) => toast(e.message, 'error') });
  const usedBy = (slug: string) => (ops.data ?? []).filter((o) => o.skills.includes(slug)).map((o) => o.name);
  const set = <K extends keyof Skill>(k: K, v: Skill[K]) => setEdit((e) => (e ? { ...e, draft: { ...e.draft, [k]: v } } : e));

  return (
    <div className="stack lg">
      <PageHead
        title="Skills"
        sub="Reusable rule sets (brainstorm, spec writing, TDD, code review…) attached to operations. Write them as rules, not suggestions: they are injected verbatim into the agent's contract."
        actions={<button className="btn primary" onClick={() => setEdit({ draft: { ...BLANK } })}>New skill</button>}
      />
      <div className="grid cols-3">
        {(skills.data ?? []).map((s) => (
          <button key={s._id} className="card card-pad" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setEdit({ id: s._id, draft: editable(s) as Skill })}>
            <div className="row between">
              <strong>{s.name}</strong>
              {s.builtIn && <span className="tag">built-in</span>}
            </div>
            <div className="tiny mono muted">{s.slug}</div>
            <p className="small ink-2" style={{ marginTop: 6 }}>{s.description}</p>
            <div className="tiny muted" style={{ marginTop: 8 }}>{usedBy(s.slug).length ? `Used by ${usedBy(s.slug).join(', ')}` : 'Not used by any operation'}</div>
          </button>
        ))}
      </div>
      {skills.data && !skills.data.length && <Empty title="No skills" />}
      {edit && (
        <Modal
          wide
          title={edit.id ? `Edit skill: ${edit.draft.name}` : 'New skill'}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && edit.draft.builtIn && <button className="btn" onClick={() => reset.mutate(edit.id!)}>Reset to default</button>}
              {edit.id && <button className="btn danger" onClick={() => confirm('Delete this skill?') && del.mutate(edit.id!)}>Delete</button>}
              <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save skill</button>
            </>
          }
        >
          <div className="stack">
            <div className="grid cols-2">
              <Field label="Name"><TextInput value={edit.draft.name} onChange={(v) => set('name', v)} /></Field>
              <Field label="Slug" hint="lowercase-with-dashes; referenced by operations"><TextInput mono value={edit.draft.slug} onChange={(v) => set('slug', v)} /></Field>
            </div>
            <Field label="Description" hint="One sentence: what the skill is for. Shown to the agent above the rules.">
              <TextInput value={edit.draft.description} onChange={(v) => set('description', v)} />
            </Field>
            <Field label="Tags"><ListEditor value={edit.draft.tags} onChange={(v) => set('tags', v)} mono={false} /></Field>
            <div className="row between">
              <span className="label">Rules (markdown)</span>
              <Seg options={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]} value={view} onChange={setView} />
            </div>
            {view === 'edit' ? (
              <TextArea rows={16} mono value={edit.draft.instructions} onChange={(v) => set('instructions', v)} placeholder={'1. Always …\n2. Never …'} />
            ) : (
              <Card><Markdown>{edit.draft.instructions || '_(empty)_'}</Markdown></Card>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
