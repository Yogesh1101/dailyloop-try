import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoInput } from '@harness/shared';
import { ago, api, editable, type RepoDoc } from '../api';
import { Card, Empty, Field, KeyValueEditor, Modal, PageHead, Seg, TextInput, useToast } from '../components/ui';
import { KnowledgeList } from './Knowledge';

const EMPTY: RepoInput = { name: '', description: '', source: 'local', localPath: '', gitUrl: '', authTokenEnv: '', defaultBranch: '', checks: {} };

function RepoForm({ value, onChange, isNew }: { value: RepoInput; onChange: (v: RepoInput) => void; isNew?: boolean }) {
  const set = <K extends keyof RepoInput>(k: K, v: RepoInput[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="stack">
      <div className="grid cols-2">
        <Field label="Name">
          <TextInput value={value.name} onChange={(v) => set('name', v)} placeholder="payments-api" />
        </Field>
        <Field label="Source">
          <Seg options={[{ id: 'local', label: 'Local path' }, { id: 'git', label: 'Git URL' }]} value={value.source} onChange={(v) => set('source', v)} />
        </Field>
      </div>
      {value.source === 'local' ? (
        <Field label="Absolute path to a git working copy" hint="Runs use isolated worktrees and new branches in this repository; your checkout and current branch are never modified.">
          <TextInput mono value={value.localPath} onChange={(v) => set('localPath', v)} placeholder="/home/me/code/payments-api" />
        </Field>
      ) : (
        <div className="grid cols-2">
          <Field label="HTTPS clone URL" hint={isNew ? 'Cloned into the harness data directory when you save.' : undefined}>
            <TextInput mono value={value.gitUrl} onChange={(v) => set('gitUrl', v)} placeholder="https://github.com/acme/payments-api.git" />
          </Field>
          <Field label="Token environment variable" hint="Name of a server env var (e.g. GITHUB_TOKEN). Needed for private repos, push and PRs. The token is never stored.">
            <TextInput mono value={value.authTokenEnv} onChange={(v) => set('authTokenEnv', v)} placeholder="GITHUB_TOKEN" />
          </Field>
        </div>
      )}
      <div className="grid cols-2">
        <Field label="Base branch" hint="Runs branch from here. Leave empty to detect.">
          <TextInput mono value={value.defaultBranch} onChange={(v) => set('defaultBranch', v)} placeholder="main" />
        </Field>
        <Field label="Description">
          <TextInput value={value.description} onChange={(v) => set('description', v)} />
        </Field>
      </div>
      {value.source === 'local' && (
        <Field label="Token environment variable (optional)" hint="Only needed if release post-actions should push or open pull requests.">
          <TextInput mono value={value.authTokenEnv} onChange={(v) => set('authTokenEnv', v)} placeholder="GITHUB_TOKEN" />
        </Field>
      )}
    </div>
  );
}

function clean(v: RepoInput): RepoInput {
  const out: RepoInput = { ...v };
  for (const k of ['localPath', 'gitUrl', 'authTokenEnv', 'defaultBranch'] as const) if (!out[k]) delete out[k];
  if (out.source === 'local') delete out.gitUrl;
  else delete out.localPath;
  return out;
}

export function Repos() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<RepoInput>(EMPTY);
  const create = useMutation({
    mutationFn: () => api.post<RepoDoc>('/repos', clean(draft)),
    onSuccess: (r) => {
      toast('Repository added');
      void qc.invalidateQueries({ queryKey: ['repos'] });
      setAdding(false);
      setDraft(EMPTY);
      nav(`/repos/${r._id}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="stack lg">
      <PageHead
        title="Repositories"
        sub="Codebases the agents work on. Each repository defines the named checks (test, lint, typecheck, build) that command gates run."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>Add repository</button>}
      />
      <Card pad={false}>
        {repos.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Base branch</th>
                <th>Checks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {repos.data.map((r) => (
                <tr key={r._id} className="click" onClick={() => nav(`/repos/${r._id}`)}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="tiny muted mono truncate" style={{ maxWidth: 420 }}>{r.source === 'local' ? r.localPath : r.gitUrl}</div>
                  </td>
                  <td><span className="tag">{r.source === 'local' ? 'local' : 'git clone'}</span></td>
                  <td><code>{r.defaultBranch}</code></td>
                  <td>
                    <div className="chips">
                      {Object.keys(r.checks ?? {}).length ? Object.keys(r.checks).map((k) => <span key={k} className="tag mono">{k}</span>) : <span className="pill serious">■ none — gates will fail</span>}
                    </div>
                  </td>
                  <td className="right">
                    <Link className="btn sm" to={`/runs/new?repo=${r._id}`} onClick={(e) => e.stopPropagation()}>
                      New run
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No repositories">Add a local git working copy or a Git URL to get started.</Empty>
        )}
      </Card>
      {adding && (
        <Modal
          title="Add repository"
          onClose={() => setAdding(false)}
          footer={
            <button className="btn primary" disabled={!draft.name || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Saving…' : 'Add repository'}
            </button>
          }
        >
          <RepoForm value={draft} onChange={setDraft} isNew />
        </Modal>
      )}
    </div>
  );
}

export function RepoDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const repo = useQuery({ queryKey: ['repo', id], queryFn: () => api.get<RepoDoc>(`/repos/${id}`) });
  const [draft, setDraft] = useState<RepoInput | null>(null);
  useEffect(() => {
    if (repo.data) setDraft({ ...EMPTY, ...(editable(repo.data) as RepoInput) });
  }, [repo.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['repo', id] });
    void qc.invalidateQueries({ queryKey: ['repos'] });
  };
  const save = useMutation({
    mutationFn: () => api.put(`/repos/${id}`, clean(draft!)),
    onSuccess: () => {
      toast('Saved');
      refresh();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const sync = useMutation({ mutationFn: () => api.post(`/repos/${id}/sync`), onSuccess: () => (toast('Synced'), refresh()), onError: (e: Error) => toast(e.message, 'error') });
  const detect = useMutation({
    mutationFn: () => api.get<Record<string, string>>(`/repos/${id}/detect-checks`),
    onSuccess: (checks) => {
      if (!Object.keys(checks).length) return toast('No toolchain detected; add checks manually');
      setDraft((d) => (d ? { ...d, checks: { ...checks, ...d.checks } } : d));
      toast(`Detected: ${Object.keys(checks).join(', ')} — review and save`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const del = useMutation({ mutationFn: () => api.del(`/repos/${id}`), onSuccess: () => (toast('Deleted'), qc.invalidateQueries({ queryKey: ['repos'] }), nav('/repos')), onError: (e: Error) => toast(e.message, 'error') });

  if (!repo.data || !draft) return <p className="muted">Loading…</p>;
  return (
    <div className="stack lg">
      <PageHead
        title={repo.data.name}
        sub={repo.data.lastError ? `Last sync error: ${repo.data.lastError}` : repo.data.lastSyncedAt ? `Synced ${ago(repo.data.lastSyncedAt)}` : undefined}
        actions={
          <>
            <Link className="btn" to={`/runs/new?repo=${id}`}>New run</Link>
            <Link className="btn" to={`/export?repo=${id}`}>Export to Claude Code</Link>
            {repo.data.source === 'git' && <button className="btn" onClick={() => sync.mutate()}>Fetch</button>}
            <button className="btn ghost danger" onClick={() => confirm('Remove this repository from the harness? Your files are not touched.') && del.mutate()}>Remove</button>
          </>
        }
      />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title="Settings">
          <RepoForm value={draft} onChange={setDraft} />
        </Card>
        <Card
          title="Checks"
          sub="Named shell commands, run in the run's worktree by command gates. A required gate whose check is missing fails."
          actions={<button className="btn sm" onClick={() => detect.mutate()}>Detect</button>}
        >
          <KeyValueEditor value={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} keyPlaceholder="test" valuePlaceholder="npm test" />
          <p className="tiny muted" style={{ marginTop: 10 }}>Built-in operations use <code>test</code> (required), and <code>typecheck</code>, <code>lint</code>, <code>build</code> (optional).</p>
        </Card>
      </div>
      <div className="row end">
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save repository</button>
      </div>
      <KnowledgeList repoId={id} title="Knowledge for this repository" />
    </div>
  );
}
