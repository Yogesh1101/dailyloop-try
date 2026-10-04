import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelInfo, Settings } from '@harness/shared';
import { api } from '../api';
import { Card, Field, NumberInput, PageHead, TextInput, useToast } from '../components/ui';

export function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const [d, setD] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setD(settings.data);
  }, [settings.data]);
  const importModels = useMutation({
    mutationFn: (provider: string) => api.get<{ provider: string; models: string[] }>(`/providers/${provider}/models`),
    onSuccess: ({ provider, models }) => {
      if (!d) return;
      const have = new Set(d.models.filter((m) => m.provider === provider).map((m) => m.id));
      const fresh = models.filter((id) => !have.has(id));
      if (!fresh.length) return toast(`No new models from ${provider} (${models.length} available, all in the catalog)`);
      setD({ ...d, models: [...d.models, ...fresh.map((id) => ({ provider, id, label: id, inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }))] });
      toast(`Added ${fresh.length} model(s) from ${provider} — set prices and limits, then save`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const save = useMutation({
    mutationFn: () => api.put('/settings', d),
    onSuccess: () => (toast('Settings saved'), qc.invalidateQueries({ queryKey: ['settings'] })),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (!d) return <p className="muted">Loading…</p>;
  const setModel = (i: number, patch: Partial<ModelInfo>) => setD({ ...d, models: d.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  return (
    <div className="stack lg">
      <PageHead title="Settings" actions={<button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Save settings</button>} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title="Providers" sub="Credentials are read from the server environment and never stored in the database.">
          <div className="stack">
            {(providers.data ?? []).map((p) => (
              <div key={p.id} className="row between">
                <div>
                  <strong>{p.label}</strong> <code>{p.id}</code>
                  <div className="tiny muted">{p.configHint}</div>
                </div>
                <div className="row">
                  {p.configured && p.id !== 'mock' && (
                    <button className="btn sm" disabled={importModels.isPending} onClick={() => importModels.mutate(p.id)} title="Add the model ids this key can use to the catalog">
                      Import models
                    </button>
                  )}
                  {p.configured ? <span className="pill good">✓ Configured</span> : <span className="pill serious">■ Not configured</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Budgets & scheduling">
          <div className="stack">
            <div className="grid cols-3">
              <Field label="Monthly budget (USD)" hint="0 = no monthly limit"><NumberInput value={d.monthlyBudgetUsd} onChange={(v) => setD({ ...d, monthlyBudgetUsd: v })} step="10" min={0} /></Field>
              <Field label="“Tonight” starts at" hint="Server local time, HH:MM"><TextInput mono value={d.nightlyStartTime} onChange={(v) => setD({ ...d, nightlyStartTime: v })} /></Field>
              <Field label="Concurrent runs"><NumberInput value={d.maxConcurrentRuns} onChange={(v) => setD({ ...d, maxConcurrentRuns: v })} min={1} /></Field>
            </div>
          </div>
        </Card>
      </div>
      <Card
        title="Model catalog"
        sub="Prices (USD per million tokens) drive cost tracking and budget gates. Req/min and tokens/min pace requests to stay under provider rate limits — set them to your tier's limits (free tiers are low). Leave empty for no pacing."
        pad={false}
      >
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model id</th>
              <th>Label</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
              <th className="num">Req/min</th>
              <th className="num">Tokens/min</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.models.map((m, i) => (
              <tr key={i}>
                <td style={{ width: 120 }}><input className="input code" value={m.provider} onChange={(e) => setModel(i, { provider: e.target.value })} /></td>
                <td><input className="input code" value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} /></td>
                <td><input className="input" value={m.label} onChange={(e) => setModel(i, { label: e.target.value })} /></td>
                {(['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const).map((k) => (
                  <td key={k} style={{ width: 96 }}><input className="input" type="number" step="0.01" min={0} value={m[k]} onChange={(e) => setModel(i, { [k]: Number(e.target.value) })} /></td>
                ))}
                {(['rpmLimit', 'tpmLimit'] as const).map((k) => (
                  <td key={k} style={{ width: k === 'tpmLimit' ? 132 : 92 }}>
                    <input className="input" type="number" min={1} step={k === 'tpmLimit' ? 1000 : 1} placeholder="—" value={m[k] ?? ''} onChange={(e) => setModel(i, { [k]: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </td>
                ))}
                <td><button className="btn ghost sm danger" onClick={() => setD({ ...d, models: d.models.filter((_, j) => j !== i) })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: 12 }}>
          <button className="btn sm" onClick={() => setD({ ...d, models: [...d.models, { provider: 'openai', id: '', label: '', inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }] })}>Add model</button>
        </div>
      </Card>
    </div>
  );
}
