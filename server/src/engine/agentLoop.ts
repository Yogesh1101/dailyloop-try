import type { Effort, ModelInfo, Usage } from '@harness/shared';
import type { AgentProvider, CompletionRequest, ConversationItem, ToolResult, ToolSpec, TokenUsage } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { ToolExecutor } from './tools';

export class BudgetExceededError extends Error {
  constructor(
    public limit: string,
    message: string,
  ) {
    super(message);
  }
}

/** The agent could not complete: refusal, provider failure, or it stopped without calling finish. */
export class AgentFailedError extends Error {}

export function costOf(usage: TokenUsage, price?: ModelInfo): number {
  if (!price) return 0;
  return (
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * price.cacheReadPerMTok +
      usage.cacheWriteTokens * price.cacheWritePerMTok) /
    1_000_000
  );
}

export interface SessionLimits {
  maxTurns: number;
  maxTokens: number;
  maxCostUsd: number;
  /** Epoch ms. */
  deadline: number;
}

export interface SessionHooks {
  onText(text: string): void;
  onToolCall(name: string, input: unknown): void;
  onToolResult(name: string, result: ToolResult): void;
  /** Called after every model turn; may throw BudgetExceededError for run-level or monthly budgets. */
  onUsage(delta: Usage, model: string): Promise<void>;
}

export interface SessionOptions {
  provider: AgentProvider;
  model: string;
  effort: Effort;
  system: string;
  tools: ToolSpec[];
  executor: ToolExecutor;
  limits: SessionLimits;
  pricing: (model: string) => ModelInfo | undefined;
  hooks: SessionHooks;
  signal: AbortSignal;
  meta?: CompletionRequest['meta'];
}

const MAX_NUDGES = 3;

/**
 * One agent conversation for one stage. Append-only transcript; gate feedback is
 * appended as a new user turn so the agent keeps its context between attempts.
 */
export class AgentSession {
  readonly messages: ConversationItem[] = [];
  turns = 0;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  readonly written = new Set<string>();

  constructor(
    private opts: SessionOptions,
    initialUserMessage: string,
  ) {
    this.messages.push({ role: 'user', text: initialUserMessage });
  }

  addUserMessage(text: string) {
    this.messages.push({ role: 'user', text });
  }

  /** Run turns until the agent calls `finish`. Throws on policy violation, budget breach or agent failure. */
  async runUntilFinish(): Promise<{ summary: string }> {
    const { provider, limits, hooks, signal } = this.opts;
    let nudges = 0;
    for (;;) {
      if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
      this.checkBudgets();
      this.turns += 1;

      let resp;
      for (let attempt = 0; ; attempt++) {
        try {
          resp = await provider.complete({
            model: this.opts.model,
            system: this.opts.system,
            messages: this.messages,
            tools: this.opts.tools,
            effort: this.opts.effort,
            signal,
            meta: this.opts.meta,
          });
          break;
        } catch (e) {
          if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
          if (e instanceof ProviderError && e.retryable && attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
            continue;
          }
          throw new AgentFailedError(e instanceof Error ? e.message : String(e));
        }
      }

      const delta: Usage = { ...resp.usage, costUsd: costOf(resp.usage, this.opts.pricing(resp.model) ?? this.opts.pricing(this.opts.model)) };
      for (const k of Object.keys(delta) as (keyof Usage)[]) this.usage[k] += delta[k];
      await hooks.onUsage(delta, resp.model);

      this.messages.push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls, raw: resp.raw });
      if (resp.text.trim()) hooks.onText(resp.text);

      if (resp.stopReason === 'refusal') {
        throw new AgentFailedError(`The model declined to continue (refusal${resp.stopDetail ? `: ${resp.stopDetail}` : ''}).`);
      }

      if (resp.stopReason === 'max_tokens') {
        // Tool inputs may be truncated: never execute them.
        if (resp.toolCalls.length) {
          this.messages.push({
            role: 'tool',
            results: resp.toolCalls.map((tc) => ({
              toolCallId: tc.id,
              isError: true,
              content: 'Not executed: your response hit the output limit and this input may be truncated. Re-issue it in smaller pieces.',
            })),
          });
        } else {
          this.addUserMessage('Your response was cut off at the output limit. Continue in smaller steps, using tools.');
        }
        continue;
      }

      if (!resp.toolCalls.length) {
        nudges += 1;
        if (nudges > MAX_NUDGES) throw new AgentFailedError('The agent repeatedly ended its turn without using tools or calling finish.');
        this.addUserMessage(
          'You ended your turn without calling a tool. You cannot talk to a human in this stage. Continue using the tools; when every required artifact is written and verified, call `finish`.',
        );
        continue;
      }
      nudges = 0;

      const results: ToolResult[] = [];
      let finished: { summary: string } | undefined;
      for (const call of resp.toolCalls) {
        hooks.onToolCall(call.name, call.input);
        if (finished) {
          results.push({ toolCallId: call.id, isError: true, content: 'Ignored: finish was already called in this turn.' });
          continue;
        }
        const outcome = await this.opts.executor.execute(call); // PolicyViolationError propagates
        if (outcome.wrote) this.written.add(outcome.wrote);
        hooks.onToolResult(call.name, outcome.result);
        results.push(outcome.result);
        if (outcome.finished) finished = outcome.finished;
      }
      this.messages.push({ role: 'tool', results });
      if (finished) return finished;
    }
  }

  private checkBudgets() {
    const { limits } = this.opts;
    if (this.turns >= limits.maxTurns) {
      throw new BudgetExceededError('maxTurns', `Stage turn limit reached (${limits.maxTurns} turns) before the agent called finish.`);
    }
    const tokens = this.usage.inputTokens + this.usage.outputTokens + this.usage.cacheReadTokens + this.usage.cacheWriteTokens;
    if (tokens >= limits.maxTokens) {
      throw new BudgetExceededError('maxTokens', `Stage token budget exhausted (${tokens.toLocaleString()} of ${limits.maxTokens.toLocaleString()}).`);
    }
    if (this.usage.costUsd >= limits.maxCostUsd) {
      throw new BudgetExceededError('maxCostUsd', `Stage cost budget exhausted ($${this.usage.costUsd.toFixed(2)} of $${limits.maxCostUsd.toFixed(2)}).`);
    }
    if (Date.now() >= limits.deadline) {
      throw new BudgetExceededError('timeout', 'Stage time limit reached before the agent called finish.');
    }
  }
}
