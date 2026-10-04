import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '@harness/shared';
import { AgentFailedError, AgentSession, BudgetExceededError, costOf } from '../src/engine/agentLoop';
import { PolicyViolationError } from '../src/engine/policy';
import { TOOL_SPECS, ToolExecutor } from '../src/engine/tools';
import type { AgentProvider, CompletionRequest, CompletionResponse, ToolCall } from '../src/providers/types';
import { engineFor, makeRepo } from './helpers';

type Step = Partial<CompletionResponse> & { calls?: [string, unknown][] };

/** Provider that replays a script of turns and records what it was sent. */
class ScriptedProvider implements AgentProvider {
  id = 'scripted';
  label = 'Scripted';
  configHint = '';
  requests: CompletionRequest[] = [];
  constructor(private steps: Step[]) {}
  isConfigured() {
    return true;
  }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(req));
    const s = this.steps.shift() ?? { calls: [['finish', { summary: 'auto' }]] };
    const toolCalls: ToolCall[] = (s.calls ?? []).map(([name, input], i) => ({ id: `t${this.requests.length}_${i}`, name, input }));
    return { text: s.text ?? '', toolCalls, stopReason: s.stopReason ?? (toolCalls.length ? 'tool_use' : 'end_turn'), usage: s.usage ?? { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'm', stopDetail: s.stopDetail };
  }
}

function session(steps: Step[], limits: Partial<{ maxTurns: number; maxTokens: number; maxCostUsd: number }> = {}) {
  const { root } = makeRepo();
  const provider = new ScriptedProvider(steps);
  const engine = engineFor(root, { allowedTools: ALL_TOOLS, writablePaths: ['src/**'] });
  const s = new AgentSession(
    {
      provider,
      model: 'm',
      effort: 'high',
      system: 'sys',
      tools: Object.values(TOOL_SPECS),
      executor: new ToolExecutor(engine, root),
      limits: { maxTurns: 10, maxTokens: 1e6, maxCostUsd: 100, deadline: Date.now() + 60_000, ...limits },
      pricing: () => ({ provider: 'scripted', id: 'm', label: 'm', inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }),
      hooks: { onText() {}, onToolCall() {}, onToolResult() {}, async onUsage() {} },
      signal: new AbortController().signal,
    },
    'Do the task',
  );
  return { s, provider, root };
}

describe('AgentSession', () => {
  it('runs tools until finish and keeps an append-only transcript', async () => {
    const { s, provider } = session([{ calls: [['read_file', { path: 'src/app.js' }]] }, { calls: [['write_file', { path: 'src/b.js', content: 'x' }]] }, { calls: [['finish', { summary: 'done' }]] }]);
    expect(await s.runUntilFinish()).toEqual({ summary: 'done' });
    expect(s.turns).toBe(3);
    expect(s.written.has('src/b.js')).toBe(true);
    // Each request extends the previous one: never edits history.
    expect(provider.requests[2].messages.slice(0, provider.requests[1].messages.length)).toEqual(provider.requests[1].messages);
    s.addUserMessage('Gate failed: fix it');
    expect(await s.runUntilFinish()).toEqual({ summary: 'auto' });
  });

  it('propagates policy violations immediately', async () => {
    const { s } = session([{ calls: [['read_file', { path: '.env' }]] }]);
    await expect(s.runUntilFinish()).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('enforces turn and cost budgets', async () => {
    const loop = Array.from({ length: 20 }, () => ({ calls: [['list_dir', { path: '.' }]] as [string, unknown][] }));
    await expect(session(loop, { maxTurns: 3 }).s.runUntilFinish()).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(session(loop, { maxCostUsd: 0.5 }).s.runUntilFinish()).rejects.toThrow(/cost budget/);
  });

  it('fails on refusal and on repeated turns without tools', async () => {
    await expect(session([{ stopReason: 'refusal', stopDetail: 'cyber: no' }]).s.runUntilFinish()).rejects.toBeInstanceOf(AgentFailedError);
    await expect(session([{ text: 'hi' }, { text: 'hi' }, { text: 'hi' }, { text: 'hi' }]).s.runUntilFinish()).rejects.toThrow(/without using tools/);
  });

  it('never executes tool calls from a truncated response', async () => {
    const { s, root } = session([{ stopReason: 'max_tokens', calls: [['write_file', { path: 'src/half.js', content: 'trunc' }]] }, { calls: [['finish', { summary: 'ok' }]] }]);
    await s.runUntilFinish();
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${root}/src/half.js`)).toBe(false);
  });

  it('prices usage from the catalog', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, { provider: 'a', id: 'm', label: 'm', inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 })).toBeCloseTo(14);
  });
});
