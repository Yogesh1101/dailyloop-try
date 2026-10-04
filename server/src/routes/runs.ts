import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Response } from 'express';
import { ApproveSchema, CreateRunSchema, FeedbackSchema, RewindSchema, type RunStage } from '@harness/shared';
import { RepoModel, RunEventModel, RunModel } from '../db/models';
import { artifactRepoPath } from '../engine/gates';
import { effectivePolicy } from '../engine/policy';
import { buildStageBrief, buildSystemPrompt } from '../engine/prompt';
import { priorArtifacts, type RunRecord } from '../engine/runner';
import { artifactsDirFor, diffAgainstBase, removeWorktree, type RepoRef } from '../engine/workspace';
import { retrieveKnowledge } from '../knowledge/retrieve';
import { HttpError } from '../util/misc';
import type { AppContext } from './context';
import { notFound, oid, param } from './util';

/** List view: drop the heavy parts (operation snapshots, skill text, artifact bodies). */
function light(run: Record<string, any>) {
  return {
    ...run,
    task: String(run.task).slice(0, 400),
    stages: (run.stages as RunStage[]).map((s) => ({
      operationKey: s.operationKey,
      name: s.name,
      status: s.status,
      attempts: s.attempts,
      rewinds: s.rewinds,
      usage: s.usage,
      error: s.error,
    })),
  };
}

function sse(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  return {
    send: (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    close: () => clearInterval(ping),
  };
}

export function runRoutes(ctx: AppContext): Router {
  const r = Router();
  const load = async (id: string) => ((await RunModel.findById(oid(id)).lean()) as unknown as RunRecord | null) ?? notFound('Run');

  r.get('/runs', async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === 'string' && req.query.status) filter.status = { $in: req.query.status.split(',') };
    if (typeof req.query.repoId === 'string' && req.query.repoId) filter.repoId = req.query.repoId;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const runs = await RunModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(runs.map(light));
  });

  r.get('/approvals', async (_req, res) => {
    const runs = await RunModel.find({ status: 'awaiting_approval' }).sort({ updatedAt: 1 }).lean();
    res.json(runs.map(light));
  });

  r.post('/runs', async (req, res) => {
    res.status(201).json(await ctx.actions.create(CreateRunSchema.parse(req.body)));
  });

  r.get('/runs/:id', async (req, res) => {
    res.json(await load(param(req.params.id)));
  });

  r.delete('/runs/:id', async (req, res) => {
    const id = param(req.params.id);
    const run = await load(id);
    if (ctx.worker.isActive(id) || run.status === 'running') throw new HttpError(409, 'Cancel the run first');
    if (run.worktreePath) {
      const repo = (await RepoModel.findById(run.repoId).lean()) as unknown as RepoRef | null;
      if (repo) await removeWorktree({ ...repo, _id: String(repo._id) }, run.worktreePath).catch(() => undefined);
    }
    await RunEventModel.deleteMany({ runId: id });
    await RunModel.deleteOne({ _id: id });
    res.status(204).end();
  });

  r.get('/runs/:id/events', async (req, res) => {
    const id = oid(param(req.params.id));
    const filter: Record<string, unknown> = { runId: id };
    if (typeof req.query.stage === 'string' && req.query.stage !== '') filter.stageIndex = Number(req.query.stage);
    const events = await RunEventModel.find(filter).sort({ ts: 1 }).limit(5000).lean();
    res.json(events);
  });

  /** Live audit log for one run (Server-Sent Events). */
  r.get('/runs/:id/stream', async (req, res) => {
    const id = oid(param(req.params.id));
    const stream = sse(res);
    const off = ctx.bus.subscribe(id, (m) => (m.type === 'event' ? stream.send('log', m.event) : stream.send('run', { runId: id })));
    stream.send('ready', { runId: id });
    req.on('close', () => {
      off();
      stream.close();
    });
  });

  /** Live run-status changes across all runs (dashboard, approvals inbox). */
  r.get('/stream', async (req, res) => {
    const stream = sse(res);
    const off = ctx.bus.subscribe('*', (m) => stream.send('run', m));
    stream.send('ready', {});
    req.on('close', () => {
      off();
      stream.close();
    });
  });

  r.get('/runs/:id/diff', async (req, res) => {
    const run = await load(param(req.params.id));
    if (!run.worktreePath || !run.baseCommit) return res.json({ stat: '', patch: '', untracked: [], note: 'No worktree yet' });
    const exists = await fs.stat(run.worktreePath).catch(() => null);
    if (!exists) return res.json({ stat: '', patch: '', untracked: [], note: 'Worktree was removed' });
    const d = await diffAgainstBase(run.worktreePath, run.baseCommit);
    const MAX = 600_000;
    res.json({ ...d, patch: d.patch.length > MAX ? `${d.patch.slice(0, MAX)}\n... [diff truncated]` : d.patch });
  });

  /** Read a file the run produced (artifacts of earlier attempts, any worktree file) for review. */
  r.get('/runs/:id/file', async (req, res) => {
    const run = await load(param(req.params.id));
    const rel = String(req.query.path ?? '');
    if (!run.worktreePath || !rel) throw new HttpError(400, 'path is required');
    const abs = path.resolve(run.worktreePath, rel);
    if (!abs.startsWith(path.resolve(run.worktreePath) + path.sep)) throw new HttpError(400, 'Path outside worktree');
    if (rel.startsWith('.git/') || rel === '.git') throw new HttpError(403, 'Forbidden');
    res.type('text/plain').send(await fs.readFile(abs, 'utf8').catch(() => notFound('File')));
  });

  /** Exactly what the agent sees for a stage: system prompt and stage brief. */
  r.get('/runs/:id/stages/:index/prompt', async (req, res) => {
    const run = await load(param(req.params.id));
    const index = Number(param(req.params.index));
    const stage = run.stages[index] ?? notFound('Stage');
    const op = stage.snapshot;
    const artifactsDir = artifactsDirFor(String(run._id));
    const ownPaths = op.artifacts.map((a) => artifactRepoPath(artifactsDir, a.path));
    const policy = effectivePolicy(op.policy, run.pipeline.globalPolicy, artifactsDir, ownPaths);
    const repo = await RepoModel.findById(run.repoId).lean();
    const knowledge = await retrieveKnowledge(run.repoId, `${run.title} ${run.task} ${op.name} ${op.description}`);
    const prior = priorArtifacts(run, index);
    const system = buildSystemPrompt({
      op,
      skills: stage.skills,
      pipeline: run.pipeline,
      policy,
      artifactsDir,
      stageIndex: index,
      stageCount: run.stages.length,
      stageNames: run.stages.map((s) => s.name),
      knowledge,
      repoChecks: (repo?.checks ?? {}) as Record<string, string>,
      baseCommit: run.baseCommit,
    });
    const brief = buildStageBrief({
      task: run.task,
      title: run.title,
      repoName: run.repoName,
      branch: run.branch,
      op,
      inputs: op.inputs.filter((i) => prior.has(i.artifact)).map((i) => prior.get(i.artifact)!),
      humanNotes: run.humanNotes,
      feedback: stage.feedback,
    });
    res.json({ system, brief, tools: policy.allowedTools, policy });
  });

  r.post('/runs/:id/approve', async (req, res) => {
    const { notes, resume } = ApproveSchema.parse(req.body ?? {});
    res.json(await ctx.actions.approve(oid(param(req.params.id)), notes, resume));
  });
  r.post('/runs/:id/reject', async (req, res) => {
    res.json(await ctx.actions.reject(oid(param(req.params.id)), FeedbackSchema.parse(req.body).feedback));
  });
  r.post('/runs/:id/retry', async (req, res) => {
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : undefined;
    res.json(await ctx.actions.retry(oid(param(req.params.id)), feedback));
  });
  r.post('/runs/:id/rewind', async (req, res) => {
    const { stageIndex, feedback } = RewindSchema.parse(req.body);
    res.json(await ctx.actions.rewind(oid(param(req.params.id)), stageIndex, feedback));
  });
  r.post('/runs/:id/cancel', async (req, res) => {
    res.json(await ctx.actions.cancel(oid(param(req.params.id))));
  });
  r.post('/runs/:id/cleanup', async (req, res) => {
    res.json(await ctx.actions.cleanup(oid(param(req.params.id))));
  });

  return r;
}
