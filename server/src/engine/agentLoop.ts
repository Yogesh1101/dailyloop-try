import type { Effort, ModelInfo, Usage } from '@harness/shared';
import type { AgentProvider, CompletionRequest, ConversationItem, ToolResult, ToolSpec, TokenUsage } from '../providers/types';
import { ProviderError } from '../providers/types';
import { abortableSleep, RateLimiter, RateLimitWaitExceeded, sharedLimiter } from './rateLimiter';
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
  /** The session is pausing (pacing, provider rate limit, transient error) before the next request. */
  onWait?(ms: number, reason: string): void;
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
  /** Shared request pacing. Defaults to the process-wide limiter. */
  limiter?: RateLimiter;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_NUDGES = 3;
/** Longest the session keeps waiting on rate limits for a single turn before giving up. */
export const MAX_RATE_WAIT_PER_TURN_MS = 20 * 60_000;
const MAX_TRANSIENT_RETRIES = 3;

const fmtWait = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.ceil(ms / 1000)}s`);

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
    const { hooks, signal } = this.opts;
    let nudges = 0;
    for (;;) {
      if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
      this.checkBudgets();
      this.turns += 1;

      const resp = await this.completeWithRetries();
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

  /** Rough token count of the next request, for tokens-per-minute pacing. */
  private estimateTokens(): number {
    return Math.ceil((this.opts.system.length + JSON.stringify(this.messages).length + JSON.stringify(this.opts.tools).length) / 4);
  }

  /**
   * One model request with the harness retry policy:
   * - pace requests under the model's rpm/tpm limits (shared across runs);
   * - on a provider rate limit, wait as long as it asks (or back off) and retry;
   * - retry transient failures a few times with backoff;
   * - an exhausted quota or a fatal error ends the stage.
   */
  private async completeWithRetries() {
    const { provider, limits, hooks, signal } = this.opts;
    const limiter = this.opts.limiter ?? sharedLimiter;
    const sleep = this.opts.sleep ?? abortableSleep;
    const info = this.opts.pricing(this.opts.model);
    const pacing = { rpm: info?.rpmLimit, tpm: info?.tpmLimit };
    const key = `${provider.id}:${this.opts.model}`;
    let rateWaited = 0;
    let transient = 0;
    let rateHits = 0;

    const pause = async (ms: number, reason: string) => {
      if (Date.now() + ms >= limits.deadline) {
        throw new BudgetExceededError('timeout', `Stage time limit would be exceeded while waiting (${reason}). Raise the operation timeout or retry later.`);
      }
      hooks.onWait?.(ms, reason);
      await sleep(ms, signal);
    };

    for (;;) {
      if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
      // Always consult the limiter: even unpaced models honour a 429 cool-down set by another run.
      let commit: (n: number) => void;
      try {
        commit = await limiter.acquire(key, pacing, pacing.tpm ? this.estimateTokens() : 0, {
          signal,
          maxWaitMs: Math.max(0, limits.deadline - Date.now()),
          onWait: (ms) =>
            hooks.onWait?.(
              ms,
              pacing.rpm || pacing.tpm
                ? `pacing ${provider.label} ${this.opts.model} under ${pacing.rpm ?? '∞'} req/min, ${pacing.tpm?.toLocaleString() ?? '∞'} tokens/min`
                : `${provider.label} ${this.opts.model} is cooling down after a rate limit`,
            ),
        });
      } catch (e) {
        if (e instanceof RateLimitWaitExceeded) {
          throw new BudgetExceededError('timeout', 'Stage time limit would be exceeded while waiting for the model rate limit.');
        }
        throw e;
      }
      try {
        const resp = await provider.complete({
          model: this.opts.model,
          system: this.opts.system,
          messages: this.messages,
          tools: this.opts.tools,
          effort: this.opts.effort,
          signal,
          meta: this.opts.meta,
        });
        const u = resp.usage;
        commit(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens);
        return resp;
      } catch (e) {
        commit(0);
        if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
        if (!(e instanceof ProviderError)) throw new AgentFailedError(e instanceof Error ? e.message : String(e));
        if (e.kind === 'quota_exhausted') {
          throw new BudgetExceededError(
            'providerQuota',
            `${provider.label} quota exhausted for ${this.opts.model}: ${e.message.slice(0, 400)}. Free-tier daily quotas reset once a day — retry the stage later, or switch the stage to another model.`,
          );
        }
        if (e.kind === 'rate_limit') {
          rateHits += 1;
          const wait = Math.min(e.retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** (rateHits - 1)), 10 * 60_000) + Math.floor(Math.random() * 1000);
          if (rateWaited + wait > MAX_RATE_WAIT_PER_TURN_MS) {
            throw new AgentFailedError(`${provider.label} kept rate-limiting for ${fmtWait(rateWaited)}. Lower the model's req/min in Settings, reduce concurrent runs, or retry later.`);
          }
          limiter.coolDown(key, wait);
          await pause(wait, `${provider.label} rate limit (429), waiting ${fmtWait(wait)}`);
          rateWaited += wait;
          continue;
        }
        if (e.kind === 'transient' && transient < MAX_TRANSIENT_RETRIES) {
          transient += 1;
          const wait = e.retryAfterMs ?? 2_000 * 2 ** (transient - 1);
          await pause(wait, `${provider.label} error, retry ${transient}/${MAX_TRANSIENT_RETRIES} in ${fmtWait(wait)}: ${e.message.slice(0, 160)}`);
          continue;
        }
        throw new AgentFailedError(e.message);
      }
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
