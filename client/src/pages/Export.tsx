import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { Card, Empty, Field, Markdown, PageHead, Select, useToast } from '../components/ui';

interface ExportFile {
  path: string;
  content: string;
}

export function ExportPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const [pipelineId, setPipelineId] = useState(params.get('pipeline') ?? '');
  const [repoId, setRepoId] = useState(params.get('repo') ?? '');
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [sel, setSel] = useState('');
  useEffect(() => {
    if (!pipelineId && pipelines.data?.length) setPipelineId(pipelines.data[0]._id);
  }, [pipelines.data, pipelineId]);

  const preview = useMutation({
    mutationFn: () => api.post<{ files: ExportFile[] }>('/export/preview', { pipelineId, repoId: repoId || undefined }),
    onSuccess: (r) => {
      setFiles(r.files);
      setSel(r.files[0]?.path ?? '');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  useEffect(() => {
    if (pipelineId) preview.mutate();
  }, [pipelineId, repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = useMutation({
    mutationFn: (overwrite: boolean) => api.post<{ root: string; written: string[]; overwritten: string[] }>('/export/write', { pipelineId, repoId, overwrite }),
    onSuccess: (r) => toast(`Wrote ${r.written.length} files to ${r.root}${r.overwritten.length ? ` (${r.overwritten.length} replaced)` : ''}`),
    onError: (e: Error) => {
      if (e instanceof ApiError && e.status === 409) {
        const conflicts: string[] = e.body?.conflicts ?? [];
        if (confirm(`These files already exist and will be replaced:\n\n${conflicts.join('\n')}\n\nOverwrite?`)) write.mutate(true);
        return;
      }
      toast(e.message, 'error');
    },
  });
  const file = files.find((f) => f.path === sel);

  return (
    <div className="stack lg">
      <PageHead
        title="Export to Claude Code"
        sub="Generate the same contract as repository configuration: CLAUDE.md and AGENTS.md, one slash command per operation, skills, a PreToolUse guard hook that enforces forbidden paths, commands and write scopes, and a gate runner that only a human can approve."
        actions={
          <button className="btn primary" disabled={!repoId || !files.length || write.isPending} onClick={() => write.mutate(false)} title={!repoId ? 'Choose a repository to write into' : undefined}>
            Write into repository
          </button>
        }
      />
      <div className="grid cols-2">
        <Field label="Pipeline">
          <Select value={pipelineId} onChange={setPipelineId} options={(pipelines.data ?? []).map((p) => ({ value: p._id, label: p.name }))} />
        </Field>
        <Field label="Repository" hint="Adds the repo's checks and pinned knowledge; required to write files.">
          <Select value={repoId} onChange={setRepoId} placeholder="(none — preview only)" options={(repos.data ?? []).map((r) => ({ value: r._id, label: r.name }))} />
        </Field>
      </div>
      {files.length ? (
        <div className="grid split">
          <Card title={`${files.length} files`} pad={false}>
            <div className="stack sm" style={{ padding: 8 }}>
              {files.map((f) => (
                <button key={f.path} className={`btn ghost sm ${f.path === sel ? 'primary' : ''}`} style={{ justifyContent: 'flex-start', fontFamily: 'var(--mono)', fontWeight: 400 }} onClick={() => setSel(f.path)}>
                  {f.path}
                </button>
              ))}
            </div>
          </Card>
          {file && (
            <Card
              title={<code>{file.path}</code>}
              actions={
                <button className="btn sm" onClick={() => navigator.clipboard.writeText(file.content).then(() => toast('Copied'))}>
                  Copy
                </button>
              }
            >
              {file.path.endsWith('.md') ? <Markdown>{file.content}</Markdown> : <pre className="out" style={{ maxHeight: '70vh' }}>{file.content}</pre>}
            </Card>
          )}
        </div>
      ) : (
        <Empty title="Choose a pipeline to preview the export" />
      )}
      <div className="callout info">
        <h3>How the gates work in Claude Code</h3>
        <p className="small">
          Each operation starts with <code>node .harness/gates.mjs start &lt;op&gt; &lt;task-slug&gt;</code>, which refuses until every earlier operation passed its gates and was approved.
          The guard hook enforces the active operation's write scope. A human approves with <code>node .harness/gates.mjs approve &lt;op&gt; &lt;task-slug&gt; "notes"</code>; the hook blocks agents from running it.
          In-harness runs are stricter still: the harness owns every tool, snapshots the working tree around each shell command, and enforces budgets.
        </p>
      </div>
    </div>
  );
}
