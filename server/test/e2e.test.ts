/**
 * End-to-end: real runner, worker, actions and MongoDB with scripted agents.
 * Runs only when E2E_MONGODB_URI is set, e.g.
 *   E2E_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Run } from '@harness/shared';
import { config } from '../src/config';
import { PipelineModel, RepoModel, RunModel, connectDb } from '../src/db/models';
import { seedDefaults } from '../src/db/seed';
import { RunActions } from '../src/engine/actions';
import { EventBus } from '../src/engine/events';
import { RunWorker } from '../src/engine/queue';
import { PipelineRunner } from '../src/engine/runner';
import { MockProvider } from '../src/providers/mock';
import { ProviderRegistry } from '../src/providers/registry';
import type { CompletionRequest, CompletionResponse } from '../src/providers/types';
import { makeRepo } from './helpers';

const URI = process.env.E2E_MONGODB_URI;

/** Agent that immediately tries to read a secret. */
class EvilProvider extends MockProvider {
  id = 'evil';
  async complete(): Promise<CompletionResponse> {
    return { text: 'Let me check the config', toolCalls: [{ id: 'e1', name: 'read_file', input: { path: '.env' } }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'evil' };
  }
}

/** Reviewer that requests changes on its first review, then approves. Records every brief it receives. */
class StrictReviewer extends MockProvider {
  id = 'reviewer';
  reviews = 0;
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const r = await super.complete(req);
    for (const c of r.toolCalls) {
      const input = c.input as { path?: string; content?: string };
      if (c.name === 'write_file' && input.path?.endsWith('review.json')) {
        this.reviews += 1;
        if (this.reviews === 1) {
          input.content = JSON.stringify({ verdict: 'request_changes', summary: 'Missing negative-number handling', findings: [{ severity: 'blocker', file: 'src/app.js', title: 'AC-2 not met', detail: 'Negative inputs are not handled', fix: 'Handle negatives' }] });
        }
      }
    }
    return r;
  }
}

/** Mock agent that records the first user message (the stage brief) of every request. */
class RecordingMock extends MockProvider {
  id = 'recording';
  briefs: string[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const first = req.messages[0];
    if (first?.role === 'user') this.briefs.push(first.text);
    return super.complete(req);
  }
}

async function waitFor(fn: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out waiting for condition');
}

describe.skipIf(!URI)('end-to-end pipeline runs', () => {
  const reviewer = new StrictReviewer();
  const recording = new RecordingMock();
  const providers = new ProviderRegistry([new MockProvider(), new EvilProvider(), reviewer, recording]);
  const bus = new EventBus();
  const runner = new PipelineRunner(providers, bus);
  const worker = new RunWorker(runner);
  const actions = new RunActions(runner, worker, bus);
  let repoId = '';
  const dbName = `harness-e2e-${Date.now()}`;

  const load = async (id: string) => (await RunModel.findById(id).lean()) as unknown as Run;
  const pipeline = async (key: string, stages: [string, string][], maxRunCostUsd = 20) =>
    String(
      (
        await PipelineModel.create({
          key,
          name: key,
          stages: stages.map(([operationKey, provider]) => ({ operationKey, overrides: { provider, model: 'mock-agent' } })),
          globalPolicy: (await PipelineModel.findOne({ key: 'standard-delivery' }).lean())!.globalPolicy,
          maxRunCostUsd,
        })
      )._id,
    );

  beforeAll(async () => {
    config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-data-'));
    await connectDb(`${URI!.replace(/\/$/, '')}/${dbName}`);
    await seedDefaults();
    const { root } = makeRepo();
    repoId = String((await RepoModel.create({ name: 'e2e', source: 'local', localPath: root, defaultBranch: 'main', checks: { test: 'true' } }))._id);
    worker.start(200);
  });

  afterAll(async () => {
    worker.stop();
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
  });

  it('halts and blocks the run when the agent touches a forbidden path', async () => {
    const pipelineId = await pipeline('violation', [['brainstorm', 'evil']]);
    const run = await actions.create({ repoId, pipelineId, task: 'Investigate the configuration loading', when: 'now' });
    await waitFor(async () => (await load(String(run._id))).status === 'blocked');
    const r = await load(String(run._id));
    expect(r.stages[0].status).toBe('blocked');
    expect(r.stages[0].violation?.rule).toBe('forbidden-path');
    expect(r.statusMessage).toContain('Policy violation');
  });

  it('review blockers rewind to implementation, then the run reaches the final human gate', async () => {
    const pipelineId = await pipeline('rewind', [
      ['plan', 'mock'],
      ['implement', 'mock'],
      ['test', 'mock'],
      ['review', 'reviewer'],
      ['release', 'mock'],
    ]);
    const run = await actions.create({ repoId, pipelineId, task: 'Add a subtract function with tests', when: 'now' });
    const id = String(run._id);
    await waitFor(async () => (await load(id)).status === 'awaiting_approval');
    await actions.approve(id, 'Plan approved; keep it minimal.', 'now'); // plan's human gate
    await waitFor(async () => {
      const r = await load(id);
      return r.status === 'awaiting_approval' && r.currentStage === 4;
    });
    const r = await load(id);
    expect(r.stages[3].rewinds).toBe(1);
    expect(r.stages[1].attempts).toBe(2);
    expect(reviewer.reviews).toBe(2);
    expect(r.humanNotes[0].notes).toContain('keep it minimal');
    await actions.approve(id, '', 'now');
    expect((await load(id)).status).toBe('completed');
  });

  it('a human rejection re-runs the stage with the feedback in its brief', async () => {
    const pipelineId = await pipeline('reject', [['brainstorm', 'recording']]);
    const run = await actions.create({ repoId, pipelineId, task: 'Explore caching strategies', when: 'now' });
    const id = String(run._id);
    await waitFor(async () => (await load(id)).status === 'awaiting_approval');
    await actions.reject(id, 'Consider a write-through cache as an option.');
    await waitFor(async () => {
      const r = await load(id);
      return r.status === 'awaiting_approval' && r.stages[0].attempts === 2;
    });
    expect(recording.briefs.at(-1)).toContain('Consider a write-through cache');
  });

  it('blocks the run when the run budget is exhausted', async () => {
    const pipelineId = await pipeline('budget', [['brainstorm', 'mock']], 0.01);
    // Park the run in the future, simulate prior spend, then release it to the worker.
    const run = await actions.create({ repoId, pipelineId, task: 'Anything at all, cheaply', when: 'at', scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    const id = String(run._id);
    await RunModel.updateOne({ _id: id }, { $set: { 'usage.costUsd': 1, scheduledFor: null } });
    await waitFor(async () => (await load(id)).status === 'blocked');
    expect((await load(id)).statusMessage).toContain('Run budget reached');
  });
});
