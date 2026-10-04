import type {
  CreateRunInput,
  KnowledgeEntryInput,
  Operation,
  Pipeline,
  RepoInput,
  Run,
  RunEvent,
  ScheduleInput,
  Settings,
  Skill,
  WithMeta,
} from '@harness/shared';

export type RepoDoc = WithMeta<RepoInput> & { lastSyncedAt?: string; lastError?: string };
export type SkillDoc = WithMeta<Skill>;
export type OperationDoc = WithMeta<Operation>;
export type PipelineDoc = WithMeta<Pipeline>;
export type KnowledgeDoc = WithMeta<KnowledgeEntryInput>;
export type ScheduleDoc = WithMeta<ScheduleInput> & { nextRunAt?: string | null; lastRunAt?: string; lastRunId?: string; lastError?: string };
export type { Run, RunEvent, Settings };

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  configHint: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: any,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const issues = json?.issues?.map((i: { path: string; message: string }) => `${i.path || 'input'}: ${i.message}`).join('; ');
    throw new ApiError(issues ? `${json.error}: ${issues}` : (json?.error ?? res.statusText), res.status, json);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: (url: string) => request<void>('DELETE', url),

  repos: () => request<RepoDoc[]>('GET', '/repos'),
  skills: () => request<SkillDoc[]>('GET', '/skills'),
  operations: () => request<OperationDoc[]>('GET', '/operations'),
  pipelines: () => request<PipelineDoc[]>('GET', '/pipelines'),
  runs: (q = '') => request<Run[]>('GET', `/runs${q}`),
  run: (id: string) => request<Run>('GET', `/runs/${id}`),
  events: (id: string) => request<RunEvent[]>('GET', `/runs/${id}/events`),
  approvals: () => request<Run[]>('GET', '/approvals'),
  providers: () => request<ProviderInfo[]>('GET', '/providers'),
  settings: () => request<Settings>('GET', '/settings'),
  knowledge: (repoId?: string) => request<KnowledgeDoc[]>('GET', `/knowledge${repoId ? `?repoId=${repoId}` : ''}`),
  schedules: () => request<ScheduleDoc[]>('GET', '/schedules'),
  createRun: (input: CreateRunInput) => request<Run>('POST', '/runs', input),
};

/** Strip server-managed fields before sending a document back. */
export function editable<T extends Record<string, any>>(doc: T): Omit<T, '_id' | 'createdAt' | 'updatedAt' | '__v'> {
  const { _id, createdAt, updatedAt, __v, ...rest } = doc;
  void _id;
  void createdAt;
  void updatedAt;
  void __v;
  return rest;
}

export const usd = (n: number | undefined) =>
  n === undefined ? '—' : n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

export const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();

export function ago(iso?: string | Date | null): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  if (s < 45) return 'just now';
  return `${fmtDur(s)} ago`;
}
function fmtDur(s: number) {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
