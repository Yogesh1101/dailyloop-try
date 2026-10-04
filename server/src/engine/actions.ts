import { ZodError } from 'zod';
import {
  modelProblem,
  OperationSchema,
  type CreateRunInput,
  type Operation,
  type RunPipelineSnapshot,
  type RunStage,
} from '@harness/shared';
import { OperationModel, PipelineModel, RepoModel, RunModel, SkillModel } from '../db/models';
import { HttpError, nextTimeOfDay, nowIso } from '../util/misc';
import { emptyUsage } from '@harness/shared';
import type { EventBus } from './events';
import type { RunWorker } from './queue';
import type { PipelineRunner, RunRecord } from './runner';
import { getSettings } from './settings';
import { removeWorktree, type RepoRef } from './workspace';

/** Human-side operations on runs. Every transition is validated; nothing bypasses a gate. */
export class RunActions {
  constructor(
    private runner: PipelineRunner,
    private worker: RunWorker,
    private bus: EventBus,
  ) {}

  /** Freeze the pipeline, operations and skills into a new run so later edits never change an in-flight run. */
  async create(input: CreateRunInput, scheduleId?: string) {
    const repo = await RepoModel.findById(input.repoId).lean();
    if (!repo) throw new HttpError(404, 'Repository not found');
    const pipeline = await PipelineModel.findById(input.pipelineId).lean();
    if (!pipeline) throw new HttpError(404, 'Pipeline not found');

    const catalog = (await getSettings()).models;
    const stages: RunStage[] = [];
    for (const ps of pipeline.stages as { operationKey: string; overrides?: Record<string, string> }[]) {
      const doc = await OperationModel.findOne({ key: ps.operationKey }).lean();
      if (!doc) throw new HttpError(400, `Pipeline references unknown operation "${ps.operationKey}"`);
      const o = ps.overrides ?? {};
      let op: Operation;
      try {
        op = OperationSchema.parse({
          ...doc,
          provider: o.provider?.trim() || doc.provider,
          model: o.model?.trim() || doc.model,
          effort: o.effort || doc.effort,
          instructions: o.extraInstructions?.trim()
            ? `${doc.instructions}\n\n## Pipeline-specific instructions\n${o.extraInstructions.trim()}`
            : doc.instructions,
        });
      } catch (e) {
        if (e instanceof ZodError) {
          throw new HttpError(400, `Operation "${doc.name}" is not valid: ${e.issues.map((i) => `${i.path.join('.') || 'operation'}: ${i.message}`).join('; ')}. Fix it under Operations (or the pipeline stage overrides).`);
        }
        throw e;
      }
      const problem = modelProblem(op.provider, op.model, catalog);
      if (problem) throw new HttpError(400, `Stage "${op.name}": ${problem} Set it on the operation or in the pipeline's stage overrides.`);
      const skills = await SkillModel.find({ slug: { $in: op.skills } }).lean();
      const missing = op.skills.filter((s) => !skills.some((k) => k.slug === s));
      if (missing.length) throw new HttpError(400, `Operation "${op.key}" references unknown skill(s): ${missing.join(', ')}`);
      stages.push({
        operationKey: op.key,
        name: op.name,
        status: 'pending',
        attempts: 0,
        rewinds: 0,
        usage: emptyUsage(),
        gateResults: [],
        artifacts: [],
        snapshot: op,
        skills: op.skills.map((slug) => {
          const s = skills.find((k) => k.slug === slug)!;
          return { slug: s.slug, name: s.name, description: s.description, instructions: s.instructions };
        }),
      });
    }

    const settings = await getSettings();
    let scheduledFor: Date | undefined;
    if (input.when === 'tonight') scheduledFor = nextTimeOfDay(settings.nightlyStartTime);
    if (input.when === 'at') {
      if (!input.scheduledFor) throw new HttpError(400, 'scheduledFor is required when when="at"');
      scheduledFor = new Date(input.scheduledFor);
    }
    const snapshot: RunPipelineSnapshot = {
      pipelineId: String(pipeline._id),
      key: pipeline.key,
      name: pipeline.name,
      constitution: pipeline.constitution ?? '',
      globalPolicy: { forbiddenPaths: [], commandDenylist: [], ...(pipeline.globalPolicy as object) },
      maxRunCostUsd: pipeline.maxRunCostUsd,
      captureKnowledge: pipeline.captureKnowledge,
    };
    const title = input.title?.trim() || input.task.trim().split('\n')[0].slice(0, 80);
    const run = await RunModel.create({
      title,
      task: input.task.trim(),
      repoId: String(repo._id),
      repoName: repo.name,
      pipeline: snapshot,
      status: 'queued',
      statusMessage: scheduledFor ? `Scheduled for ${scheduledFor.toLocaleString()}` : 'Queued',
      currentStage: 0,
      stages,
      scheduledFor,
      scheduleId,
      usage: emptyUsage(),
      humanNotes: [],
    });
    const id = String(run._id);
    await this.bus.emit(id, null, 'system', `Run created from pipeline "${pipeline.name}" with ${stages.length} stage(s)`);
    void this.worker.tick();
    return run.toObject();
  }

  private async loadIdle(id: string): Promise<RunRecord> {
    const run = await this.runner.load(id).catch(() => null);
    if (!run) throw new HttpError(404, 'Run not found');
    if (this.worker.isActive(id) || run.status === 'running') throw new HttpError(409, 'Run is executing; cancel it first');
    return run;
  }

  private current(run: RunRecord, status: RunStage['status'][]) {
    const stage = run.stages[run.currentStage];
    if (!stage || !status.includes(stage.status)) {
      throw new HttpError(409, `Current stage is "${stage?.status ?? 'none'}"; expected ${status.join(' or ')}`);
    }
    return stage;
  }

  async approve(id: string, notes: string, resume: 'now' | 'tonight') {
    const run = await this.loadIdle(id);
    if (run.status !== 'awaiting_approval') throw new HttpError(409, 'Run is not awaiting approval');
    const stage = this.current(run, ['awaiting_approval']);
    const gate = stage.snapshot.gates.find((g) => g.type === 'human_approval' && g.enabled);
    const at = nowIso();

    const repo = (await RepoModel.findById(run.repoId).lean()) as unknown as RepoRef | null;
    if (!repo) throw new HttpError(404, 'Repository no longer exists');
    repo._id = String(repo._id);
    try {
      await this.runner.postActions(run, repo, stage);
    } catch (e) {
      run.statusMessage = `Approval held: ${(e as Error).message}`;
      await this.runner.save(run);
      await this.bus.emit(id, run.currentStage, 'approval', `Approval could not complete: ${(e as Error).message}`, { level: 'error' });
      throw new HttpError(400, (e as Error).message);
    }

    stage.approval = { decision: 'approved', notes, at };
    stage.gateResults.push({
      gateId: gate?.id ?? 'human',
      name: gate?.name ?? 'Human approval',
      type: 'human_approval',
      passed: true,
      message: notes.trim() ? 'Approved with binding notes' : 'Approved',
      output: notes.trim() || undefined,
      attempt: stage.attempts,
      at,
    });
    if (notes.trim()) run.humanNotes.push({ stageKey: stage.operationKey, notes: notes.trim(), at });
    stage.status = 'passed';
    stage.finishedAt = at;
    run.currentStage += 1;
    await this.bus.emit(id, run.currentStage - 1, 'approval', `Approved: ${stage.name}${notes.trim() ? ` — ${notes.trim()}` : ''}`);

    if (run.currentStage >= run.stages.length) {
      await this.runner.complete(run);
    } else {
      const settings = await getSettings();
      run.status = 'queued';
      run.scheduledFor = resume === 'tonight' ? nextTimeOfDay(settings.nightlyStartTime) : null;
      run.statusMessage = run.scheduledFor ? `Continues tonight at ${run.scheduledFor.toLocaleString()}` : 'Queued';
      await this.runner.save(run);
      void this.worker.tick();
    }
    return run;
  }

  async reject(id: string, feedback: string) {
    const run = await this.loadIdle(id);
    if (run.status !== 'awaiting_approval') throw new HttpError(409, 'Run is not awaiting approval');
    const stage = this.current(run, ['awaiting_approval']);
    const gate = stage.snapshot.gates.find((g) => g.type === 'human_approval' && g.enabled);
    const at = nowIso();
    stage.approval = { decision: 'rejected', notes: feedback, at };
    stage.gateResults.push({
      gateId: gate?.id ?? 'human', name: gate?.name ?? 'Human approval', type: 'human_approval',
      passed: false, message: 'Rejected by human reviewer', output: feedback, attempt: stage.attempts, at,
    });
    stage.feedback = `## Human reviewer rejected attempt ${stage.attempts}\n${feedback.trim()}`;
    stage.status = 'pending';
    run.status = 'queued';
    run.scheduledFor = null;
    run.statusMessage = `Re-running ${stage.name} with reviewer feedback`;
    await this.runner.save(run);
    await this.bus.emit(id, run.currentStage, 'approval', `Rejected: ${stage.name} — ${feedback.trim()}`, { level: 'warn' });
    void this.worker.tick();
    return run;
  }

  async retry(id: string, feedback?: string, change?: { provider?: string; model?: string; scope: 'stage' | 'remaining' }) {
    const run = await this.loadIdle(id);
    if (!['blocked', 'error', 'cancelled'].includes(run.status)) throw new HttpError(409, `Cannot retry a run that is ${run.status}`);
    const stage = run.stages[run.currentStage];
    if (!stage) throw new HttpError(409, 'No stage to retry');
    if (change?.model) {
      // A deliberate, logged human decision: the frozen snapshot is edited only here.
      const provider = change.provider || stage.snapshot.provider;
      try {
        this.runner.providers.get(provider);
      } catch {
        throw new HttpError(400, `Unknown provider "${provider}"`);
      }
      const problem = modelProblem(provider, change.model, (await getSettings()).models);
      if (problem) throw new HttpError(400, problem);
      const last = change.scope === 'stage' ? run.currentStage : run.stages.length - 1;
      for (let j = run.currentStage; j <= last; j++) {
        if (run.stages[j].status === 'passed') continue;
        run.stages[j].snapshot = { ...run.stages[j].snapshot, provider, model: change.model };
      }
      await this.bus.emit(
        id,
        run.currentStage,
        'approval',
        `Model switched by a human to ${provider}/${change.model} for ${change.scope === 'stage' ? 'this stage' : 'this and later stages'}`,
        { level: 'warn' },
      );
    }
    const parts: string[] = [];
    if (stage.violation) {
      parts.push(`## Your previous attempt was halted\nPolicy violation [${stage.violation.rule}]: ${stage.violation.detail}\nDo not repeat it; find a compliant way or record the blocker in your artifact.`);
    } else if (stage.error) {
      parts.push(`## Previous attempt ended with: ${stage.error}`);
    }
    if (feedback?.trim()) parts.push(`## Human guidance for this retry\n${feedback.trim()}`);
    stage.feedback = [stage.feedback, ...parts].filter(Boolean).join('\n\n') || undefined;
    stage.status = 'pending';
    run.status = 'queued';
    run.scheduledFor = null;
    run.finishedAt = null;
    run.statusMessage = `Retrying ${stage.name}`;
    await this.runner.save(run);
    await this.bus.emit(id, run.currentStage, 'system', `Retry requested for ${stage.name}${feedback?.trim() ? ' with guidance' : ''}`);
    void this.worker.tick();
    return run;
  }

  async rewind(id: string, stageIndex: number, feedback: string) {
    const run = await this.loadIdle(id);
    if (run.status === 'queued') throw new HttpError(409, 'Run is queued; wait or cancel first');
    const last = Math.min(run.currentStage, run.stages.length - 1);
    if (stageIndex > last) throw new HttpError(400, 'Can only rewind to the current or an earlier stage');
    for (let j = stageIndex; j <= last; j++) run.stages[j].status = 'pending';
    run.stages[stageIndex].feedback = `## Human sent the work back to this stage\n${feedback.trim()}`;
    run.currentStage = stageIndex;
    run.status = 'queued';
    run.scheduledFor = null;
    run.finishedAt = null;
    run.statusMessage = `Rewound to ${run.stages[stageIndex].name}`;
    await this.runner.save(run);
    await this.bus.emit(id, stageIndex, 'approval', `Rewound to ${run.stages[stageIndex].name}: ${feedback.trim()}`, { level: 'warn' });
    void this.worker.tick();
    return run;
  }

  async cancel(id: string) {
    if (this.worker.cancel(id)) return { cancelled: true };
    const run = await this.runner.load(id).catch(() => null);
    if (!run) throw new HttpError(404, 'Run not found');
    if (['completed', 'cancelled'].includes(run.status)) throw new HttpError(409, `Run is already ${run.status}`);
    run.status = 'cancelled';
    run.statusMessage = 'Cancelled by user';
    run.finishedAt = new Date();
    await this.runner.save(run);
    await this.bus.emit(id, null, 'system', 'Run cancelled');
    return { cancelled: true };
  }

  async cleanup(id: string) {
    const run = await this.loadIdle(id);
    if (['queued', 'awaiting_approval'].includes(run.status)) throw new HttpError(409, 'Finish or cancel the run before removing its worktree');
    if (!run.worktreePath) return run;
    const repo = (await RepoModel.findById(run.repoId).lean()) as unknown as RepoRef | null;
    if (repo) {
      repo._id = String(repo._id);
      await removeWorktree(repo, run.worktreePath);
    }
    run.worktreePath = undefined;
    run.statusMessage = `${run.statusMessage ?? ''} (worktree removed; branch ${run.branch} kept)`.trim();
    await this.runner.save(run);
    return run;
  }
}
