import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  AgentProvider,
  CompletionRequest,
  CompletionResponse,
  ConversationItem,
  StopReason,
  ToolCall,
} from './types';
import { classify429, ProviderError, retryAfterMs } from './types';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

/** Models that predate adaptive thinking / effort. Everything newer gets both. */
const LEGACY = /claude-(3|haiku-4|sonnet-4-5|sonnet-4-0|sonnet-4-2|opus-4-0|opus-4-1|opus-4-5)/;

/** Models that accept the server-side refusal fallback ("default" routing) on the Claude API. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const MAX_OUTPUT_TOKENS = 64_000;

function toMessages(items: ConversationItem[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const item of items) {
    if (item.role === 'assistant') {
      if (item.raw?.provider === 'anthropic') {
        // Same provider: send the content back unchanged (preserves thinking blocks).
        out.push({ role: 'assistant', content: item.raw.data as BetaContentBlockParam[] });
      } else {
        const content: BetaContentBlockParam[] = [];
        if (item.text) content.push({ type: 'text', text: item.text });
        for (const tc of item.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input as Record<string, unknown> });
        }
        out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] });
      }
      continue;
    }
    const blocks: BetaContentBlockParam[] =
      item.role === 'tool'
        ? item.results.map(
            (r): BetaToolResultBlockParam => ({
              type: 'tool_result',
              tool_use_id: r.toolCallId,
              content: r.content,
              is_error: r.isError || undefined,
            }),
          )
        : [{ type: 'text', text: item.text }];
    const last = out[out.length - 1];
    // Merge consecutive user-side items (tool results followed by gate feedback) into one turn.
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      (last.content as BetaContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

function mapStop(reason: BetaMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements AgentProvider {
  id = 'anthropic';
  label = 'Anthropic (Claude)';
  configHint = 'Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile) in the server environment.';
  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  }

  private getClient(): Anthropic {
    // Retries are owned by the harness (one policy for every provider, visible in the run log).
    this.client ??= new Anthropic({ maxRetries: 0 });
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!req.model?.trim()) throw new ProviderError('Anthropic: no model is configured for this stage. Choose a model for the operation or the pipeline stage.');
    const legacy = LEGACY.test(req.model);
    const params: BetaMessageStreamParams = {
      model: req.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: req.system,
      messages: toMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        // Large file contents stream as generated. The harness validates every input before running it.
        eager_input_streaming: true,
      })),
      // Stable system prompt + tools per stage: cache the prefix across turns.
      cache_control: { type: 'ephemeral' },
      ...(legacy ? {} : { thinking: { type: 'adaptive' as const }, output_config: { effort: req.effort } }),
      ...(FALLBACK_MODELS.has(req.model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    };

    let message: BetaMessage | undefined;
    for (let attempt = 0; attempt < 3 && !message; attempt++) {
      try {
        const stream = this.getClient().beta.messages.stream(params, { signal: req.signal });
        message = await stream.finalMessage();
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (err instanceof Anthropic.RateLimitError) {
          const wait = retryAfterMs(err.headers, err.message);
          throw new ProviderError(`Anthropic rate limit: ${err.message}`, classify429(err.message, wait), wait);
        }
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new ProviderError('Anthropic authentication failed: check ANTHROPIC_API_KEY');
        }
        if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
          throw new ProviderError(`Anthropic rejected the request (${err.status}): ${err.message}`);
        }
        if (err instanceof Anthropic.APIError) {
          // 5xx, 529 overloaded, connection errors and timeouts.
          throw new ProviderError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, 'transient', retryAfterMs(err.headers, err.message));
        }
        // Not an API error: an eagerly streamed tool input that could not be parsed. Re-issue the turn.
        if (attempt === 2) throw new ProviderError(`Unparseable tool input from model: ${String(err)}`, 'transient');
      }
    }
    if (!message) throw new ProviderError('No response from Anthropic', 'transient');

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const stop = mapStop(message.stop_reason);
    const details = message.stop_details;
    return {
      text: text.join('\n'),
      toolCalls,
      stopReason: stop,
      stopDetail:
        stop === 'refusal' && details
          ? `${details.category ?? 'uncategorized'}: ${details.explanation ?? ''}`.trim()
          : message.stop_reason ?? undefined,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: message.model,
      raw: { provider: 'anthropic', data: message.content },
    };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.getClient().models.list()) ids.push(m.id);
    return ids.sort();
  }
}
