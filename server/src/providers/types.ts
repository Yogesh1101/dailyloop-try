import type { ArtifactContract, Effort } from '@harness/shared';

/** Provider-neutral tool definition. The harness owns every tool, so gates apply to all providers equally. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * Provider-neutral transcript. Assistant turns keep the provider's raw content so
 * the same provider gets it back verbatim (thinking blocks etc. must round-trip unchanged).
 * The transcript is append-only.
 */
export type ConversationItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: { provider: string; data: unknown } }
  | { role: 'tool'; results: ToolResult[] };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ConversationItem[];
  tools: ToolSpec[];
  effort: Effort;
  signal?: AbortSignal;
  /** Stage hints. Real providers ignore them; the offline mock agent uses them to produce valid artifacts. */
  meta?: {
    operationKey: string;
    artifacts: (ArtifactContract & { repoPath: string })[];
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  stopDetail?: string;
  usage: TokenUsage;
  /** Model that actually served the request (may differ after a server-side fallback). */
  model: string;
  raw?: { provider: string; data: unknown };
}

export interface AgentProvider {
  id: string;
  label: string;
  /** How to configure this provider, shown in Settings. */
  configHint: string;
  isConfigured(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Model ids this key can use (for "Import models" in Settings). */
  listModels?(): Promise<string[]>;
}

/**
 * rate_limit       - too many requests right now; wait (retryAfterMs when the provider says how long) and retry
 * quota_exhausted  - daily / billing quota used up; waiting minutes will not help, block for a human
 * transient        - 5xx, overload, network: retry with backoff
 * fatal            - bad request, auth, unknown model: do not retry
 */
export type ProviderErrorKind = 'rate_limit' | 'quota_exhausted' | 'transient' | 'fatal';

export class ProviderError extends Error {
  constructor(
    message: string,
    public kind: ProviderErrorKind = 'fatal',
    public retryAfterMs?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

/** A provider-requested delay longer than this is treated as an exhausted quota, not a rate limit. */
export const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;

function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** How long the provider asked us to wait: Retry-After headers, or hints in the error body (Gemini "retryDelay"). */
export function retryAfterMs(headers: unknown, message = ''): number | undefined {
  const ms = header(headers, 'retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = header(headers, 'retry-after');
  if (ra) {
    if (Number.isFinite(Number(ra))) return Number(ra) * 1000;
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const m =
    /retry in\s+([\d.]+)\s*(ms|s|m|h)\b/i.exec(message) ??
    /retryDelay["'\s:]+"?([\d.]+)(ms|s|m|h)/i.exec(message);
  if (m) {
    const n = Number(m[1]);
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2].toLowerCase() as 'ms' | 's' | 'm' | 'h'];
    return n * unit;
  }
  return undefined;
}

/** Classify an HTTP 429 from any provider: per-minute throttling vs. a quota that will not recover soon. */
export function classify429(message: string, waitMs: number | undefined, code?: string): ProviderErrorKind {
  // Gemini names the quota that tripped (…PerMinute… vs …PerDay…); OpenAI uses code "insufficient_quota" for billing.
  // Do not match "billing": Gemini's per-minute 429 text mentions billing too.
  if (code === 'insufficient_quota' || /insufficient_quota|per\s*day|PerDay|daily (limit|quota)/i.test(message)) return 'quota_exhausted';
  if (waitMs !== undefined && waitMs > MAX_RATE_LIMIT_WAIT_MS) return 'quota_exhausted';
  return 'rate_limit';
}
