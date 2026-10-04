import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '@harness/shared';
import { AgentFailedError, AgentSession, BudgetExceededError } from '../src/engine/agentLoop';
import { RateLimiter } from '../src/engine/rateLimiter';
import { TOOL_SPECS, ToolExecutor } from '../src/engine/tools';
import { classify429, ProviderError, retryAfterMs, type AgentProvider, type CompletionResponse } from '../src/providers/types';
import { engineFor, makeRepo } from './helpers';

/** Fake clock: sleeping advances time instantly. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('retry-after parsing and 429 classification', () => {
  it('reads headers and provider hints', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '7' }))).toBe(7000);
    expect(retryAfterMs({ 'retry-after-ms': '1500' })).toBe(1500);
    expect(retryAfterMs(undefined, 'Quota exceeded for metric ... Please retry in 22.5s.')).toBe(22_500);
    expect(retryAfterMs(undefined, '"retryDelay": "41s"')).toBe(41_000);
    expect(retryAfterMs(undefined, 'nothing here')).toBeUndefined();
  });

  it('separates per-minute throttling from exhausted quotas', () => {
    const perMinute = 'You exceeded your current quota, please check your plan and billing details. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 20s.';
    const perDay = 'You exceeded your current quota. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier';
    expect(classify429(perMinute, 20_000)).toBe('rate_limit');
    expect(classify429(perDay, undefined)).toBe('quota_exhausted');
    expect(classify429('quota', undefined, 'insufficient_quota')).toBe('quota_exhausted');
    expect(classify429('slow down', 3 * 3_600_000)).toBe('quota_exhausted');
  });
});

describe('RateLimiter', () => {
  it('paces requests per minute', async () => {
    const c = clock();
    const rl = new RateLimiter(c.now, c.sleep);
    for (let i = 0; i < 3; i++) await rl.acquire('k', { rpm: 3 }, 0);
    expect(c.sleeps).toEqual([]);
    await rl.acquire('k', { rpm: 3 }, 0);
    expect(c.sleeps).toHaveLength(1);
    expect(c.sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('paces tokens per minute using actual usage', async () => {
    const c = clock();
    const rl = new RateLimiter(c.now, c.sleep);
    const commit = await rl.acquire('k', { tpm: 1000 }, 400);
    commit(900); // the request turned out bigger than estimated
    await rl.acquire('k', { tpm: 1000 }, 400);
    expect(c.sleeps).toHaveLength(1);
    // Different model keys do not share a budget.
    await rl.acquire('other', { tpm: 1000 }, 900);
    expect(c.sleeps).toHaveLength(1);
  });

  it('honours a provider cool-down for every caller on the key', async () => {
    const c = clock();
    const rl = new RateLimiter(c.now, c.sleep);
    rl.coolDown('k', 30_000);
    expect(rl.waitFor('k', {}, 0)).toBe(30_000);
    await rl.acquire('k', {}, 0);
    expect(c.sleeps[0]).toBeGreaterThanOrEqual(30_000);
  });
});

class FlakyProvider implements AgentProvider {
  id = 'flaky';
  label = 'Flaky';
  configHint = '';
  calls = 0;
  constructor(private errors: ProviderError[]) {}
  isConfigured() {
    return true;
  }
  async complete(): Promise<CompletionResponse> {
    this.calls += 1;
    const e = this.errors.shift();
    if (e) throw e;
    return { text: '', toolCalls: [{ id: 'f', name: 'finish', input: { summary: 'ok' } }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'm' };
  }
}

function session(errors: ProviderError[], pacing: { rpmLimit?: number; tpmLimit?: number } = {}) {
  const { root } = makeRepo();
  const c = clock();
  const waits: string[] = [];
  const provider = new FlakyProvider(errors);
  const s = new AgentSession(
    {
      provider,
      model: 'm',
      effort: 'high',
      system: 'sys',
      tools: Object.values(TOOL_SPECS),
      executor: new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS }), root),
      limits: { maxTurns: 10, maxTokens: 1e6, maxCostUsd: 100, deadline: Date.now() + 3_600_000 },
      pricing: () => ({ provider: 'flaky', id: 'm', label: 'm', inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, ...pacing }),
      hooks: { onText() {}, onToolCall() {}, onToolResult() {}, async onUsage() {}, onWait: (_ms, reason) => waits.push(reason) },
      signal: new AbortController().signal,
      limiter: new RateLimiter(c.now, c.sleep),
      sleep: c.sleep,
    },
    'go',
  );
  return { s, provider, waits, sleeps: c.sleeps };
}

describe('AgentSession retry policy', () => {
  it('waits out provider rate limits for as long as the provider asks', async () => {
    const { s, provider, waits, sleeps } = session([new ProviderError('429', 'rate_limit', 30_000), new ProviderError('429', 'rate_limit', 5_000)]);
    expect(await s.runUntilFinish()).toEqual({ summary: 'ok' });
    expect(provider.calls).toBe(3);
    expect(waits.filter((w) => w.includes('rate limit (429)'))).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(30_000);
  });

  it('retries transient errors with backoff, then gives up', async () => {
    const ok = session([new ProviderError('503', 'transient'), new ProviderError('503', 'transient')]);
    expect(await ok.s.runUntilFinish()).toEqual({ summary: 'ok' });
    const bad = session(Array.from({ length: 5 }, () => new ProviderError('503', 'transient')));
    await expect(bad.s.runUntilFinish()).rejects.toBeInstanceOf(AgentFailedError);
    expect(bad.provider.calls).toBe(4);
  });

  it('blocks on an exhausted quota instead of waiting for hours', async () => {
    const { s, provider } = session([new ProviderError('daily quota', 'quota_exhausted')]);
    const err = await s.runUntilFinish().catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).limit).toBe('providerQuota');
    expect(provider.calls).toBe(1);
  });

  it('does not retry fatal errors', async () => {
    const { s, provider } = session([new ProviderError('400 bad request', 'fatal')]);
    await expect(s.runUntilFinish()).rejects.toBeInstanceOf(AgentFailedError);
    expect(provider.calls).toBe(1);
  });

  it('gives up when a rate limit persists past the per-turn cap', async () => {
    const { s } = session(Array.from({ length: 10 }, () => new ProviderError('429', 'rate_limit', 9 * 60_000)));
    await expect(s.runUntilFinish()).rejects.toThrow(/kept rate-limiting/);
  });

  it('paces requests under the model limits', async () => {
    const { s, waits } = session([], { rpmLimit: 1 });
    await s.runUntilFinish();
    s.addUserMessage('again');
    await s.runUntilFinish();
    expect(waits.some((w) => w.startsWith('pacing'))).toBe(true);
  });
});
