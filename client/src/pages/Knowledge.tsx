import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KNOWLEDGE_TYPES, type KnowledgeEntryInput } from '@harness/shared';
import { ago, api, editable, type KnowledgeDoc } from '../api';
import { Card, Check, Empty, Field, ListEditor, Markdown, Modal, PageHead, Select, TextArea, TextInput, useToast } from '../components/ui';

function EntryModal({ entry, repoId, onClose }: { entry?: KnowledgeDoc; repoId?: string | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [d, setD] = useState<KnowledgeEntryInput>(
    entry ? (editable(entry) as KnowledgeEntryInput) : { repoId: repoId ?? null, type: 'convention', title: '', content: '', tags: [], pinned: false, source: 'manual' },
  );
  const set = <K extends keyof KnowledgeEntryInput>(k: K, v: KnowledgeEntryInput[K]) => setD({ ...d, [k]: v });
  const save = useMutation({
    mutationFn: () => (entry ? api.put(`/knowledge/${entry._id}`, d) : api.post('/knowledge', d)),
    onSuccess: () => {
      toast('Saved');
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/knowledge/${entry!._id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      onClose();
    },
  });
  return (
    <Modal
      wide
      title={entry ? 'Edit knowledge entry' : 'New knowledge entry'}
      onClose={onClose}
      footer={
        <>
          {entry && <button className="btn danger" onClick={() => confirm('Delete this entry?') && del.mutate()}>Delete</button>}
          <button className="btn primary" disabled={!d.title || !d.content || save.isPending} onClick={() => save.mutate()}>Save</button>
        </>
      }
    >
      <div className="stack">
        <div className="grid cols-3">
          <Field label="Scope">
            <Select value={d.repoId ?? 'global'} onChange={(v) => set('repoId', v === 'global' ? null : v)} options={[{ value: 'global', label: 'Global (all repositories)' }, ...(repos.data ?? []).map((r) => ({ value: r._id, label: r.name }))]} />
          </Field>
          <Field label="Type"><Select value={d.type} onChange={(v) => set('type', v)} options={KNOWLEDGE_TYPES.map((t) => ({ value: t, label: t }))} /></Field>
          <Field label="Retrieval"><Check checked={d.pinned} onChange={(v) => set('pinned', v)} label="Pinned — always injected" /></Field>
        </div>
        <Field label="Title"><TextInput value={d.title} onChange={(v) => set('title', v)} placeholder="Errors are returned as RFC 7807 problem+json" /></Field>
        <Field label="Content (markdown)" hint="State facts and decisions precisely; agents treat this as binding context.">
          <TextArea rows={12} value={d.content} onChange={(v) => set('content', v)} />
        </Field>
        <Field label="Tags" hint="Boost retrieval for matching tasks"><ListEditor value={d.tags} onChange={(v) => set('tags', v)} mono={false} /></Field>
      </div>
    </Modal>
  );
}

export function KnowledgeList({ repoId, title }: { repoId?: string; title?: string }) {
  const q = useQuery({ queryKey: ['knowledge', repoId ?? 'all'], queryFn: () => api.knowledge(repoId) });
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [edit, setEdit] = useState<KnowledgeDoc | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title={title ?? 'Entries'} sub="Pinned entries are injected into every stage; others are retrieved by relevance to the task." actions={<button className="btn sm primary" onClick={() => setEdit('new')}>Add entry</button>} pad={false}>
      {q.data?.length ? (
        <table className="table">
          <tbody>
            {q.data.map((k) => (
              <tr key={k._id}>
                <td style={{ width: 110 }}><span className="tag">{k.type}</span></td>
                <td>
                  <button className="btn ghost" style={{ padding: 0, height: 'auto', fontWeight: 550 }} onClick={() => setOpen(open === k._id ? null : k._id)}>
                    {k.pinned ? '📌 ' : ''}{k.title}
                  </button>
                  <div className="tiny muted">
                    {k.repoId ? repos.data?.find((r) => r._id === k.repoId)?.name ?? 'repo' : 'global'} · {k.source === 'run' ? 'captured from a run' : 'manual'} · {ago(k.updatedAt)}
                    {k.tags.length ? ` · ${k.tags.join(', ')}` : ''}
                  </div>
                  {open === k._id && <div className="card card-pad" style={{ marginTop: 8 }}><Markdown>{k.content}</Markdown></div>}
                </td>
                <td className="right"><button className="btn sm" onClick={() => setEdit(k)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No knowledge yet">Add architecture decisions, conventions and glossary terms. Approved specs and plans are captured automatically.</Empty>
      )}
      {edit && <EntryModal entry={edit === 'new' ? undefined : edit} repoId={!repoId || repoId === 'global' ? null : repoId} onClose={() => setEdit(null)} />}
    </Card>
  );
}

export function Knowledge() {
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [scope, setScope] = useState('');
  return (
    <div className="stack lg">
      <PageHead
        title="Knowledge base"
        sub="The project memory layer: architecture decisions, conventions, glossary, incidents and approved specs. Agents receive pinned entries always and the most relevant others per task."
      />
      <div className="row">
        <span className="label">Show</span>
        <div style={{ width: 280 }}>
          <Select value={scope} onChange={setScope} options={[{ value: '', label: 'Everything' }, { value: 'global', label: 'Global only' }, ...(repos.data ?? []).map((r) => ({ value: r._id, label: r.name }))]} />
        </div>
      </div>
      <KnowledgeList key={scope} repoId={scope || undefined} />
    </div>
  );
}
