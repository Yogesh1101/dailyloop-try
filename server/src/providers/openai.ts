import OpenAI from 'openai';
import type { AgentProvider, CompletionRequest, CompletionResponse, ConversationItem, StopReason, ToolCall } from './types';
import { ProviderError } from './types';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toMessages(system: string, items: ConversationItem[]): Msg[] {
  const out: Msg[] = [{ role: 'system', content: system }];
  for (const item of items) {
    if (item.role === 'user') out.push({ role: 'user', content: item.text });
    else if (item.role === 'tool') {
      for (const r of item.results) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
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
 * OpenAI Chat Completions adapter. Set OPENAI_BASE_URL to use any OpenAI-compatible
 * server (Ollama, vLLM, LM Studio, gateways).
 */
export class OpenAIProvider implements AgentProvider {
  id = 'openai';
  label = 'OpenAI / OpenAI-compatible';
  configHint = 'Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL for an OpenAI-compatible endpoint.';
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return !!(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
  }

  private getClient(): OpenAI {
    this.client ??= new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'not-needed',
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const compatible = !!process.env.OPENAI_BASE_URL;
    let resp: OpenAI.Chat.Completions.ChatCompletion;
    try {
      resp = await this.getClient().chat.completions.create(
        {
          model: req.model,
          messages: toMessages(req.system, req.messages),
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          ...(compatible ? { max_tokens: 16_384 } : { max_completion_tokens: 16_384 }),
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (req.signal?.aborted) throw err;
      if (err instanceof OpenAI.RateLimitError) throw new ProviderError(`OpenAI rate limit: ${err.message}`, true);
      if (err instanceof OpenAI.AuthenticationError) throw new ProviderError('OpenAI authentication failed: check OPENAI_API_KEY');
      if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError) {
        throw new ProviderError(`OpenAI rejected the request (${err.status}): ${err.message}`);
      }
      if (err instanceof OpenAI.APIError) throw new ProviderError(`OpenAI API error ${err.status ?? ''}: ${err.message}`, true);
      throw new ProviderError(`OpenAI request failed: ${String(err)}`, true);
    }

    const choice = resp.choices[0];
    if (!choice) throw new ProviderError('OpenAI returned no choices');
    const toolCalls: ToolCall[] = [];
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        input = { __invalid_json: tc.function.arguments };
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }
    const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: choice.message.content ?? '',
      toolCalls,
      stopReason: mapStop(choice.finish_reason),
      stopDetail: choice.finish_reason ?? undefined,
      usage: {
        inputTokens: Math.max(0, (resp.usage?.prompt_tokens ?? 0) - cached),
        outputTokens: resp.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      model: resp.model,
    };
  }
}
