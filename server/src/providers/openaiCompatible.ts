import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { Effort } from '@harness/shared';
import type { AgentProvider, CompletionRequest, CompletionResponse, ConversationItem, StopReason, ToolCall } from './types';
import { classify429, ProviderError, retryAfterMs } from './types';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantRaw = { content: string | null; tool_calls?: unknown[]; extra_content?: unknown };

export interface CompatOptions {
  id: string;
  label: string;
  configHint: string;
  apiKey: () => string | undefined;
  baseURL: () => string | undefined;
  isConfigured: () => boolean;
  /** Which output-limit parameter the endpoint accepts. */
  tokenParam: () => 'max_tokens' | 'max_completion_tokens';
  maxOutputTokens: number;
  /** Map harness effort to the endpoint's `reasoning_effort`, or undefined to omit it. */
  reasoningEffort?: (effort: Effort) => 'low' | 'medium' | 'high' | undefined;
  /** Rewrite tool JSON Schemas for endpoints that reject some keywords. */
  sanitizeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
  /** Strip a prefix from listed model ids (Gemini lists "models/<id>"). */
  modelIdPrefix?: string;
}

/** Remove JSON Schema keywords recursively. */
export function stripKeywords(schema: Record<string, unknown>, keywords: string[]): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!keywords.includes(k)) out[k] = walk(val);
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Chat Completions adapter for any OpenAI-compatible endpoint (OpenAI, Gemini, Ollama, vLLM, gateways).
 * Assistant turns from this provider are replayed verbatim so provider-specific fields survive
 * (e.g. Gemini thought signatures on tool calls); the transcript stays append-only.
 */
export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly configHint: string;
  private client: OpenAI | null = null;
  /** Models that rejected `reasoning_effort`; it is omitted for them from then on. */
  private noEffort = new Set<string>();

  constructor(private opts: CompatOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.configHint = opts.configHint;
  }

  isConfigured(): boolean {
    return this.opts.isConfigured();
  }

  protected getClient(): OpenAI {
    // Retries are owned by the harness (one policy for every provider, visible in the run log).
    this.client ??= new OpenAI({ apiKey: this.opts.apiKey() || 'not-needed', baseURL: this.opts.baseURL() || undefined, maxRetries: 0 });
    return this.client;
  }

  toMessages(system: string, items: ConversationItem[]): Msg[] {
    const out: Msg[] = [{ role: 'system', content: system }];
    for (const item of items) {
      if (item.role === 'user') out.push({ role: 'user', content: item.text });
      else if (item.role === 'tool') {
        for (const r of item.results) {
          out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content });
        }
      } else if (item.raw?.provider === this.id) {
        const raw = item.raw.data as AssistantRaw;
        out.push({
          role: 'assistant',
          content: raw.content ?? null,
          ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls } : {}),
          ...(raw.extra_content ? { extra_content: raw.extra_content } : {}),
        } as Msg);
      } else {
        out.push({
          role: 'assistant',
          content: item.text || null,
          ...(item.toolCalls.length
            ? {
                tool_calls: item.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
                })),
              }
            : {}),
        });
      }
    }
    return out;
  }

  private toProviderError(err: unknown): ProviderError {
    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      const msg = `${this.label} ${status ?? ''}: ${err.message}`.trim();
      if (status === 429) {
        const wait = retryAfterMs(err.headers, err.message);
        return new ProviderError(msg, classify429(err.message, wait, (err as { code?: string }).code ?? undefined), wait);
      }
      if (status === 401 || status === 403) return new ProviderError(`${this.label} authentication failed: ${this.configHint}`);
      if (status === 400 || status === 404 || status === 422) return new ProviderError(`${this.label} rejected the request (${status}): ${err.message}`);
      if (status === undefined || status === 408 || status === 409 || status >= 500) {
        return new ProviderError(msg, 'transient', retryAfterMs(err.headers, err.message));
      }
      return new ProviderError(msg);
    }
    return new ProviderError(`${this.label} request failed: ${String(err)}`, 'transient');
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const effort = this.opts.reasoningEffort && !this.noEffort.has(req.model) ? this.opts.reasoningEffort(req.effort) : undefined;
    const body = (withEffort: boolean): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming => ({
      model: req.model,
      messages: this.toMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: this.opts.sanitizeSchema ? this.opts.sanitizeSchema(t.inputSchema) : t.inputSchema },
      })),
      [this.opts.tokenParam()]: this.opts.maxOutputTokens,
      ...(withEffort && effort ? { reasoning_effort: effort } : {}),
    });

    let resp: OpenAI.Chat.Completions.ChatCompletion;
    try {
      resp = await this.getClient().chat.completions.create(body(true), { signal: req.signal });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      // Some models on compatible endpoints reject reasoning_effort: drop it once and remember.
      if (effort && err instanceof OpenAI.APIError && err.status === 400 && /reasoning/i.test(err.message)) {
        this.noEffort.add(req.model);
        try {
          resp = await this.getClient().chat.completions.create(body(false), { signal: req.signal });
        } catch (err2) {
          if (req.signal?.aborted) throw err2;
          throw this.toProviderError(err2);
        }
      } else {
        throw this.toProviderError(err);
      }
    }

    const choice = resp.choices?.[0];
    if (!choice) throw new ProviderError(`${this.label} returned no choices`, 'transient');
    const message = choice.message;
    const rawCalls: Record<string, unknown>[] = [];
    const toolCalls: ToolCall[] = [];
    for (const tc of (message.tool_calls ?? []) as unknown as Record<string, any>[]) {
      if (tc.type && tc.type !== 'function') continue;
      // Some compatible servers omit ids; the tool result must reference one.
      const id = tc.id || `call_${randomUUID().slice(0, 12)}`;
      rawCalls.push({ ...tc, id, type: 'function' });
      let input: unknown;
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = { __invalid_json: tc.function?.arguments };
      }
      toolCalls.push({ id, name: tc.function?.name ?? '', input });
    }
    const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const extra = (message as unknown as { extra_content?: unknown }).extra_content;
    return {
      text: message.content ?? '',
      toolCalls,
      stopReason: mapStop(choice.finish_reason),
      stopDetail: choice.finish_reason ?? undefined,
      usage: {
        inputTokens: Math.max(0, (resp.usage?.prompt_tokens ?? 0) - cached),
        outputTokens: resp.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      model: resp.model || req.model,
      raw: { provider: this.id, data: { content: message.content ?? null, tool_calls: rawCalls, ...(extra ? { extra_content: extra } : {}) } satisfies AssistantRaw },
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.getClient().models.list()) ids.push(m.id);
      const prefix = this.opts.modelIdPrefix;
      return ids.map((id) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id)).sort();
    } catch (err) {
      throw this.toProviderError(err);
    }
  }
}
