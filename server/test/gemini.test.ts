import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini';
import { ProviderError, type CompletionRequest } from '../src/providers/types';
import { TOOL_SPECS } from '../src/engine/tools';

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** Minimal stand-in for Gemini's OpenAI-compatible endpoint. */
const requests: { path: string; body: any }[] = [];
const replies: Reply[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: data ? JSON.parse(data) : undefined });
      const r = replies.shift() ?? { status: 500, body: { error: { message: 'no reply queued' } } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai/`;
});
afterAll(() => {
  server.close();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_BASE_URL;
});

const completion = (message: object, finish = 'tool_calls') => ({
  status: 200,
  body: { id: 'x', object: 'chat.completion', created: 0, model: 'gemini-2.5-flash', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
});

const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'gemini-2.5-flash',
  system: 'You are an agent',
  messages: [{ role: 'user', text: 'Do it' }],
  tools: [TOOL_SPECS.read_file, TOOL_SPECS.finish],
  effort: 'xhigh',
  ...over,
});

describe('GeminiProvider (OpenAI-compatible endpoint)', () => {
  it('is configured from GEMINI_API_KEY', () => {
    expect(new GeminiProvider().isConfigured()).toBe(true);
  });

  it('sends a Gemini-shaped request and replays tool calls verbatim with thought signatures', async () => {
    const p = new GeminiProvider();
    const sig = { google: { thought_signature: 'sig-abc' } };
    replies.push(completion({ content: null, tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' }, extra_content: sig }] }));
    const r1 = await p.complete(req());
    const sent = requests.at(-1)!;
    expect(sent.path).toBe('/v1beta/openai/chat/completions');
    expect(sent.body.max_tokens).toBe(32_768);
    expect(sent.body.max_completion_tokens).toBeUndefined();
    expect(sent.body.reasoning_effort).toBe('high');
    expect(JSON.stringify(sent.body.tools)).not.toContain('additionalProperties');
    expect(r1.toolCalls[0].id).toMatch(/^call_/); // id was missing in the response
    expect(r1.toolCalls[0].input).toEqual({ path: 'README.md' });
    expect(r1.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });

    replies.push(completion({ content: 'done', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] }));
    await p.complete(
      req({
        messages: [
          { role: 'user', text: 'Do it' },
          { role: 'assistant', text: r1.text, toolCalls: r1.toolCalls, raw: r1.raw },
          { role: 'tool', results: [{ toolCallId: r1.toolCalls[0].id, content: '# readme' }] },
        ],
      }),
    );
    const replayed = requests.at(-1)!.body.messages;
    expect(replayed[2].tool_calls[0].extra_content).toEqual(sig);
    expect(replayed[2].tool_calls[0].id).toBe(r1.toolCalls[0].id);
    expect(replayed[3]).toEqual({ role: 'tool', tool_call_id: r1.toolCalls[0].id, content: '# readme' });
  });

  it('drops reasoning_effort for models that reject it', async () => {
    const p = new GeminiProvider();
    replies.push({ status: 400, body: { error: { message: 'Invalid argument: reasoning_effort is not supported for this model' } } });
    replies.push(completion({ content: 'ok' }, 'stop'));
    const r = await p.complete(req({ model: 'gemini-2.5-flash-lite' }));
    expect(r.stopReason).toBe('end_turn');
    expect(requests.at(-1)!.body.reasoning_effort).toBeUndefined();
    replies.push(completion({ content: 'ok' }, 'stop'));
    await p.complete(req({ model: 'gemini-2.5-flash-lite' }));
    expect(requests.at(-1)!.body.reasoning_effort).toBeUndefined();
  });

  it('classifies 429s: per-minute waits, per-day quota blocks', async () => {
    const p = new GeminiProvider();
    replies.push({ status: 429, body: { error: { message: 'Resource exhausted. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 12s.' } } });
    const minute = await p.complete(req()).catch((e) => e);
    expect(minute).toBeInstanceOf(ProviderError);
    expect(minute.kind).toBe('rate_limit');
    expect(minute.retryAfterMs).toBe(12_000);

    replies.push({ status: 429, body: { error: { message: 'Quota exceeded. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } });
    expect((await p.complete(req()).catch((e) => e)).kind).toBe('quota_exhausted');

    replies.push({ status: 503, body: { error: { message: 'overloaded' } }, headers: { 'retry-after': '3' } });
    const busy = await p.complete(req()).catch((e) => e);
    expect(busy.kind).toBe('transient');
    expect(busy.retryAfterMs).toBe(3000);

    replies.push({ status: 401, body: { error: { message: 'bad key' } } });
    expect((await p.complete(req()).catch((e) => e)).kind).toBe('fatal');
  });

  it('lists models without the "models/" prefix', async () => {
    replies.push({ status: 200, body: { object: 'list', data: [{ id: 'models/gemini-2.5-flash', object: 'model', created: 0, owned_by: 'google' }, { id: 'models/gemini-2.5-flash-lite', object: 'model', created: 0, owned_by: 'google' }] } });
    expect(await new GeminiProvider().listModels()).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });
});
