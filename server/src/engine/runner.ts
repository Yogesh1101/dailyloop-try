import fs from 'node:fs';
import path from 'node:path';
import type { GateResult, Run, RunStage, StageArtifact, Usage } from '@harness/shared';
import { RepoModel, RunModel, UsageRecordModel } from '../db/models';
import { captureRunKnowledge, retrieveKnowledge } from '../knowledge/retrieve';
import type { ProviderRegistry } from '../providers/registry';
import { nowIso } from '../util/misc';
import { AgentFailedError, AgentSession, BudgetExceededError } from './agentLoop';
import type { EventBus } from './events';
import { artifactRepoPath, evaluateGates, failureReport } from './gates';
import { createPullRequest } from './github';
import { effectivePolicy, PolicyEngine, PolicyViolationError } from './policy';
import { buildStageBrief, buildSystemPrompt } from './prompt';
import { getSettings, monthSpend, priceLookup } from './settings';
import { TOOL_SPECS, ToolExecutor } from './tools';
import {
  artifactsDirFor,
  commitAll,
  prepareWorktree,
  pushBranch,
  reattachWorktree,
  remoteUrl,
  type RepoRef,
} from './workspace';
import { sectionText } from './artifacts';

/** Run as held in memory by the runner (dates as Date, ids as ObjectId-or-string). */
export type RunRecord = Omit<Run, '_id' | 'scheduledFor' | 'startedAt' | 'finishedAt' | 'createdAt' | 'updatedAt'> & {
  _id: unknown;
  scheduledFor?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

type StageOutcome = 'advance' | 'rewound' | 'paused';

const MUTABLE: (keyof RunRecord)[] = [
  'status',
  'statusMessage',
  'currentStage',
  'stages',
  'branch',
  'baseBranch',
  'baseCommit',
  'worktreePath',
  'pullRequestUrl',
  'scheduledFor',
  'usage',
  'humanNotes',
  'startedAt',
  'finishedAt',
];

export function addUsage(target: Usage, delta: Usage) {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.costUsd += delta.costUsd;
}

/** Latest valid artifact per id from stages before `index` that passed. */
export function priorArtifacts(run: RunRecord, index: number): Map<string, { artifact: StageArtifact; fromStage: string }> {
  const map = new Map<string, { artifact: StageArtifact; fromStage: string }>();
  run.stages.slice(0, index).forEach((s) => {
    if (s.status !== 'passed') return;
    for (const a of s.artifacts) if (a.valid) map.set(a.id, { artifact: a, fromStage: s.name });
  });
  return map;
}

export class PipelineRunner {
  constructor(
    private providers: ProviderRegistry,
    private bus: EventBus,
  ) {}

  async load(runId: string): Promise<RunRecord> {
    const doc = await RunModel.findById(runId).lean();
    if (!doc) throw new Error(`Run ${runId} not found`);
    return doc as unknown as RunRecord;
  }

  async save(run: RunRecord) {
    const $set: Record<string, unknown> = {};
    for (const k of MUTABLE) $set[k] = run[k] ?? null;
    await RunModel.updateOne({ _id: run._id }, { $set });
    this.bus.runChanged(String(run._id));
  }

  private emit(run: RunRecord, stage: number | null, kind: Parameters<EventBus['emit']>[2], message: string, opts?: Parameters<EventBus['emit']>[4]) {
    return this.bus.emit(String(run._id), stage, kind, message, opts);
  }

  /** Drive a run forward until it completes, pauses for a human, or blocks. Worker sets status=running first. */
  async execute(runId: string, signal: AbortSignal): Promise<void> {
    const run = await this.load(runId);
    try {
      const repo = (await RepoModel.findById(run.repoId).lean()) as unknown as RepoRef | null;
      if (!repo) throw new Error('Repository no longer exists');
      repo._id = String(repo._id);

      if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
        await this.emit(run, null, 'system', `Preparing isolated worktree for ${repo.name}`);
        const ws =
          run.branch && run.baseCommit
            ? await reattachWorktree(repo, runId, run.branch, run.baseCommit, run.title)
            : await prepareWorktree(repo, runId, run.title);
        Object.assign(run, ws);
        await this.emit(run, null, 'system', `Worktree ready on branch ${ws.branch} (base ${ws.baseCommit.slice(0, 10)})`, { data: ws });
      }
      run.startedAt ??= new Date();
      run.status = 'running';
      await this.save(run);

      while (run.currentStage < run.stages.length) {
        if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
        const stage = run.stages[run.currentStage];
        if (stage.status === 'passed' || stage.status === 'skipped') {
          run.currentStage += 1;
          continue;
        }
        const outcome = await this.runStage(run, repo, run.currentStage, signal);
        if (outcome === 'paused') return;
        if (outcome === 'advance') {
          run.currentStage += 1;
          await this.save(run);
        }
      }
      await this.complete(run);
    } catch (e) {
      const aborted = signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
      const stage = run.stages[run.currentStage];
      if (aborted) {
        run.status = 'cancelled';
        run.statusMessage = 'Cancelled by user';
        if (stage && ['running', 'gating'].includes(stage.status)) {
          stage.status = 'blocked';
          stage.error = 'Cancelled';
        }
      } else {
        run.status = 'error';
        run.statusMessage = (e as Error).message;
        if (stage && ['running', 'gating'].includes(stage.status)) {
          stage.status = 'failed';
          stage.error = (e as Error).message;
        }
        await this.emit(run, run.currentStage, 'system', `Run error: ${(e as Error).message}`, { level: 'error' });
      }
      run.finishedAt = new Date();
      await this.save(run);
    }
  }

  async complete(run: RunRecord) {
    run.status = 'completed';
    run.statusMessage = 'All stages passed their gates';
    run.finishedAt = new Date();
    if (run.pipeline.captureKnowledge) {
      const n = await captureRunKnowledge(run);
      if (n) await this.emit(run, null, 'system', `Captured ${n} artifact(s) into the knowledge base`);
    }
    await this.save(run);
    await this.emit(run, null, 'system', 'Run completed: every stage passed its gates');
  }

  private async block(run: RunRecord, index: number, stageStatus: RunStage['status'], message: string, gate?: Omit<GateResult, 'at' | 'attempt'>) {
    const stage = run.stages[index];
    stage.status = stageStatus;
    stage.error = message;
    if (gate) stage.gateResults.push({ ...gate, attempt: stage.attempts, at: nowIso() });
    run.status = 'blocked';
    run.statusMessage = `${stage.name}: ${message}`;
    await this.save(run);
    await this.emit(run, index, 'stage', `Blocked: ${message}`, { level: 'error' });
  }

  private async runStage(run: RunRecord, repo: RepoRef, index: number, signal: AbortSignal): Promise<StageOutcome> {
    const runId = String(run._id);
    const stage = run.stages[index];
    const op = stage.snapshot;
    const worktree = run.worktreePath!;
    const artifactsDir = artifactsDirFor(runId);
    const prior = priorArtifacts(run, index);

    // --- Pre-flight gates: inputs, budgets, provider -------------------------------------------
    const missing = op.inputs.filter((i) => i.required && !prior.has(i.artifact)).map((i) => i.artifact);
    if (missing.length) {
      await this.block(run, index, 'blocked', `Missing required input artifact(s): ${missing.join(', ')}. Add the producing stage before this one in the pipeline.`, {
        gateId: 'inputs', name: 'Required inputs', type: 'artifacts', passed: false, message: `Missing: ${missing.join(', ')}`,
      });
      return 'paused';
    }
    const settings = await getSettings();
    const spent = await monthSpend();
    if (settings.monthlyBudgetUsd > 0 && spent >= settings.monthlyBudgetUsd) {
      await this.block(run, index, 'blocked', `Monthly budget reached ($${spent.toFixed(2)} of $${settings.monthlyBudgetUsd.toFixed(2)}).`, {
        gateId: 'monthly-budget', name: 'Monthly budget', type: 'budget', passed: false, message: 'Monthly budget reached',
      });
      return 'paused';
    }
    if (run.usage.costUsd >= run.pipeline.maxRunCostUsd) {
      await this.block(run, index, 'blocked', `Run budget reached ($${run.usage.costUsd.toFixed(2)} of $${run.pipeline.maxRunCostUsd.toFixed(2)}).`, {
        gateId: 'run-budget', name: 'Run budget', type: 'budget', passed: false, message: 'Run budget reached',
      });
      return 'paused';
    }
    let provider;
    try {
      provider = this.providers.get(op.provider);
    } catch (e) {
      await this.block(run, index, 'blocked', (e as Error).message);
      return 'paused';
    }
    if (!provider.isConfigured()) {
      await this.block(run, index, 'blocked', `Provider "${provider.label}" is not configured. ${provider.configHint}`);
      return 'paused';
    }
    const stageTokens = () => stage.usage.inputTokens + stage.usage.outputTokens + stage.usage.cacheReadTokens + stage.usage.cacheWriteTokens;
    if (stageTokens() >= op.policy.maxTokens || stage.usage.costUsd >= op.policy.maxCostUsd) {
      await this.block(run, index, 'blocked', 'Stage budget already spent by earlier attempts. Raise the operation budget to continue.', {
        gateId: 'stage-budget', name: 'Stage budget', type: 'budget', passed: false, message: 'Stage budget spent',
      });
      return 'paused';
    }

    // --- Build the contract ----------------------------------------------------------------------
    const ownPaths = op.artifacts.map((a) => artifactRepoPath(artifactsDir, a.path));
    const policy = effectivePolicy(op.policy, run.pipeline.globalPolicy, artifactsDir, ownPaths);
    const engine = new PolicyEngine(policy, worktree);
    const executor = new ToolExecutor(engine, worktree, signal);
    const repoDoc = await RepoModel.findById(run.repoId).lean();
    const repoChecks = (repoDoc?.checks ?? {}) as Record<string, string>;
    const knowledge = await retrieveKnowledge(run.repoId, `${run.title} ${run.task} ${op.name} ${op.description}`);
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
      repoChecks,
      baseCommit: run.baseCommit,
    });
    const previousOutput = ownPaths.filter((p) => fs.existsSync(path.join(worktree, p)));
    const brief = buildStageBrief({
      task: run.task,
      title: run.title,
      repoName: run.repoName,
      branch: run.branch,
      op,
      inputs: op.inputs.filter((i) => prior.has(i.artifact)).map((i) => prior.get(i.artifact)!),
      humanNotes: run.humanNotes,
      feedback: stage.feedback,
      previousOutput: previousOutput.length ? previousOutput : undefined,
    });

    stage.status = 'running';
    stage.startedAt ??= nowIso();
    stage.error = undefined;
    stage.violation = undefined;
    stage.feedback = undefined;
    run.status = 'running';
    run.statusMessage = `Running ${op.name}`;
    await this.save(run);
    await this.emit(run, index, 'stage', `Stage started: ${op.name} (${op.provider}/${op.model}, effort ${op.effort})`, {
      data: { tools: policy.allowedTools, writable: policy.writablePaths, knowledge: knowledge.map((k) => k.title) },
    });

    const pricing = priceLookup(settings);
    let monthSpent = spent;
    const session = new AgentSession(
      {
        provider,
        model: op.model,
        effort: op.effort,
        system,
        tools: policy.allowedTools.map((t) => TOOL_SPECS[t]),
        executor,
        limits: {
          maxTurns: op.policy.maxTurns,
          maxTokens: op.policy.maxTokens - stageTokens(),
          maxCostUsd: op.policy.maxCostUsd - stage.usage.costUsd,
          deadline: Date.now() + op.policy.timeoutMinutes * 60_000,
        },
        pricing,
        signal,
        meta: { operationKey: op.key, artifacts: op.artifacts.map((a) => ({ ...a, repoPath: artifactRepoPath(artifactsDir, a.path) })) },
        hooks: {
          onText: (t) => void this.emit(run, index, 'agent_text', t),
          onToolCall: (name, input) => {
            const i = input as Record<string, unknown> | undefined;
            const hint = i && typeof i === 'object' ? String(i.path ?? i.command ?? i.pattern ?? '') : '';
            void this.emit(run, index, 'tool_call', `${name}${hint ? ` ${hint}` : ''}`, { data: input });
          },
          onWait: (ms, reason) => {
            run.statusMessage = `${op.name}: waiting ${Math.ceil(ms / 1000)}s — ${reason}`;
            void this.save(run);
            void this.emit(run, index, 'system', `Waiting ${Math.ceil(ms / 1000)}s: ${reason}`, { level: 'warn' });
          },
          onToolResult: (name, r) =>
            void this.emit(run, index, 'tool_result', `${name}: ${r.content.split('\n')[0].slice(0, 200)}`, {
              level: r.isError ? 'warn' : 'info',
              data: r.content.slice(0, 3000),
            }),
          onUsage: async (delta, model) => {
            addUsage(stage.usage, delta);
            addUsage(run.usage, delta);
            run.statusMessage = `Running ${op.name}`;
            monthSpent += delta.costUsd;
            await UsageRecordModel.create({
              runId,
              repoId: run.repoId,
              repoName: run.repoName,
              pipelineKey: run.pipeline.key,
              operationKey: op.key,
              provider: op.provider,
              model,
              ...delta,
            });
            await this.save(run);
            await this.emit(run, index, 'usage', `+${delta.inputTokens + delta.outputTokens} tokens, $${delta.costUsd.toFixed(4)}`, { data: delta });
            if (run.usage.costUsd >= run.pipeline.maxRunCostUsd) {
              throw new BudgetExceededError('maxRunCostUsd', `Run budget exhausted ($${run.usage.costUsd.toFixed(2)} of $${run.pipeline.maxRunCostUsd.toFixed(2)}).`);
            }
            if (settings.monthlyBudgetUsd > 0 && monthSpent >= settings.monthlyBudgetUsd) {
              throw new BudgetExceededError('monthlyBudgetUsd', `Monthly budget exhausted ($${monthSpent.toFixed(2)} of $${settings.monthlyBudgetUsd.toFixed(2)}).`);
            }
          },
        },
      },
      brief,
    );

    // --- Attempt loop ----------------------------------------------------------------------------
    let attemptsThisPass = 0;
    for (;;) {
      attemptsThisPass += 1;
      stage.attempts += 1;
      stage.status = 'running';
      await this.save(run);

      let finish: { summary: string };
      try {
        finish = await session.runUntilFinish();
      } catch (e) {
        if (e instanceof PolicyViolationError) {
          stage.violation = { rule: e.rule, detail: e.detail, tool: e.tool, input: e.input?.slice(0, 2000), at: nowIso() };
          await this.emit(run, index, 'violation', `Policy violation [${e.rule}]: ${e.detail}`, { level: 'error', data: stage.violation });
          await this.block(run, index, 'blocked', `Policy violation [${e.rule}]: ${e.detail}`, {
            gateId: 'policy', name: 'Policy guardrails', type: 'policy', passed: false, message: `[${e.rule}] ${e.detail}`, output: e.input,
          });
          return 'paused';
        }
        if (e instanceof BudgetExceededError) {
          await this.block(run, index, 'blocked', e.message, { gateId: e.limit, name: 'Budget', type: 'budget', passed: false, message: e.message });
          return 'paused';
        }
        if (e instanceof AgentFailedError) {
          await this.block(run, index, 'failed', e.message);
          return 'paused';
        }
        throw e;
      }

      stage.summary = finish.summary;
      stage.status = 'gating';
      await this.save(run);
      await this.emit(run, index, 'stage', `Agent called finish; evaluating gates`, { data: { summary: finish.summary } });

      const evaluation = await evaluateGates({
        op,
        worktree,
        artifactsDir,
        baseCommit: run.baseCommit!,
        repoChecks,
        priorArtifacts: new Map([...prior].map(([k, v]) => [k, v.artifact])),
        attempt: stage.attempts,
        signal,
        onProgress: (m) => void this.emit(run, index, 'gate', m),
      });
      if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
      stage.artifacts = evaluation.artifacts;
      stage.gateResults.push(...evaluation.results);
      for (const r of evaluation.results) {
        await this.emit(run, index, 'gate', `${r.passed ? 'PASS' : 'FAIL'} ${r.name}: ${r.message}`, {
          level: r.passed ? 'info' : 'warn',
          data: r.output?.slice(0, 3000),
        });
      }

      if (evaluation.passed) {
        if (op.postActions.commit) {
          const sha = await commitAll(worktree, `harness(${op.key}): ${finish.summary.split('\n')[0].slice(0, 72)}\n\nRun: ${runId}\nStage: ${op.name} (attempt ${stage.attempts})`);
          if (sha) await this.emit(run, index, 'system', `Committed stage output ${sha.slice(0, 10)} to ${run.branch}`);
        }
        if (evaluation.humanGate) {
          stage.status = 'awaiting_approval';
          run.status = 'awaiting_approval';
          run.statusMessage = `Waiting for human approval: ${op.name}`;
          await this.save(run);
          await this.emit(run, index, 'approval', `Awaiting human approval: ${evaluation.humanGate.name}`, { data: evaluation.humanGate });
          return 'paused';
        }
        await this.postActions(run, repo, stage);
        stage.status = 'passed';
        stage.finishedAt = nowIso();
        await this.save(run);
        await this.emit(run, index, 'stage', `Stage passed: ${op.name}`);
        return 'advance';
      }

      const report = failureReport(evaluation.results);
      if (evaluation.onFail === 'retry' && attemptsThisPass < op.maxAttempts) {
        await this.emit(run, index, 'stage', `Gates failed; retrying (attempt ${attemptsThisPass + 1} of ${op.maxAttempts})`, { level: 'warn' });
        session.addUserMessage(
          `# Gate failures (attempt ${stage.attempts})\nYour work did not pass the gates. Fix the cause of every failure below, re-verify, then call \`finish\` again.\n\n${report}`,
        );
        continue;
      }

      if (evaluation.onFail === 'rewind' && op.rewindTo) {
        const target = run.stages.findIndex((s, i) => i < index && s.operationKey === op.rewindTo);
        if (target >= 0 && stage.rewinds < op.maxRewinds) {
          stage.rewinds += 1;
          await commitAll(worktree, `harness(${op.key}): attempt ${stage.attempts} sent work back to ${op.rewindTo}\n\nRun: ${runId}`);
          for (let j = target; j <= index; j++) run.stages[j].status = 'pending';
          run.stages[target].feedback = `# Sent back by "${op.name}" (rewind ${stage.rewinds} of ${op.maxRewinds})\nThe later stage rejected the work. Address every point below.\n\n${report}`;
          run.currentStage = target;
          run.statusMessage = `${op.name} sent the work back to ${run.stages[target].name}`;
          await this.save(run);
          await this.emit(run, index, 'stage', `Rewinding to "${run.stages[target].name}" (${stage.rewinds}/${op.maxRewinds})`, { level: 'warn' });
          return 'rewound';
        }
      }

      const why =
        evaluation.onFail === 'halt'
          ? 'a gate configured to halt failed'
          : evaluation.onFail === 'rewind'
            ? `rewind limit reached (${op.maxRewinds}) or no earlier "${op.rewindTo ?? '?'}" stage`
            : `gates still failing after ${attemptsThisPass} attempt(s)`;
      await this.block(run, index, 'failed', `Gates failed: ${why}. Human action required.`);
      return 'paused';
    }
  }

  /** Push / open PR after a stage passes (used by approval for human-gated stages). */
  async postActions(run: RunRecord, repo: RepoRef, stage: RunStage) {
    const pa = stage.snapshot.postActions;
    if (!pa.push && !pa.openPullRequest) return;
    const index = run.stages.indexOf(stage);
    await pushBranch(repo, run.worktreePath!, run.branch!);
    await this.emit(run, index, 'system', `Pushed ${run.branch} to origin`);
    if (pa.openPullRequest && !run.pullRequestUrl) {
      const token = repo.authTokenEnv ? process.env[repo.authTokenEnv] : undefined;
      if (!token) throw new Error(`Cannot open a pull request: set the repo's token env var (${repo.authTokenEnv ?? 'not configured'}).`);
      const remote = await remoteUrl(run.worktreePath!);
      if (!remote) throw new Error('Cannot open a pull request: no origin remote');
      const release = stage.artifacts.find((a) => a.format === 'markdown');
      const title = (release && sectionText(release.content, 'PR Title')?.split('\n')[0]) || run.title;
      const body = (release && sectionText(release.content, 'PR Description')) || run.task;
      run.pullRequestUrl = await createPullRequest({
        remote,
        token,
        head: run.branch!,
        base: run.baseBranch ?? repo.defaultBranch,
        title,
        body: `${body}\n\n---\n_Opened by Agentic Harness run ${String(run._id)} after human approval._`,
      });
      await this.emit(run, index, 'system', `Opened pull request ${run.pullRequestUrl}`);
    }
  }
}
