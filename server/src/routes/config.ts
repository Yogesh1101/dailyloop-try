import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import {
  KnowledgeEntrySchema,
  modelProblem,
  OperationSchema,
  PipelineSchema,
  RepoSchema,
  ScheduleSchema,
  SkillSchema,
} from '@harness/shared';
import {
  KnowledgeModel,
  OperationModel,
  PipelineModel,
  RepoModel,
  RunModel,
  ScheduleModel,
  SkillModel,
} from '../db/models';
import { builtInDefault } from '../db/seed';
import { clonePathFor, git, repoRoot, syncRepo, validateLocalRepo, type RepoRef } from '../engine/workspace';
import { getSettings } from '../engine/settings';
import { Scheduler } from '../scheduler';
import { HttpError } from '../util/misc';
import type { AppContext } from './context';
import { notFound, oid, param } from './util';

const ACTIVE = ['queued', 'running', 'awaiting_approval'];

/** Suggest check commands from the repo's toolchain files. */
async function detectChecks(root: string): Promise<Record<string, string>> {
  const has = async (f: string) => !!(await fs.stat(path.join(root, f)).catch(() => null));
  const checks: Record<string, string> = {};
  if (await has('package.json')) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) ? 'bun' : 'npm';
    const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : `run ${s}`}`);
    const scripts = pkg.scripts ?? {};
    if (scripts.test && !/no test specified/.test(scripts.test)) checks.test = run('test');
    if (scripts.lint) checks.lint = run('lint');
    if (scripts.typecheck) checks.typecheck = run('typecheck');
    else if (await has('tsconfig.json')) checks.typecheck = 'npx tsc --noEmit';
    if (scripts.build) checks.build = run('build');
  } else if (await has('go.mod')) {
    Object.assign(checks, { test: 'go test ./...', lint: 'go vet ./...', build: 'go build ./...' });
  } else if (await has('Cargo.toml')) {
    Object.assign(checks, { test: 'cargo test', lint: 'cargo clippy -- -D warnings', build: 'cargo build' });
  } else if ((await has('pyproject.toml')) || (await has('requirements.txt'))) {
    checks.test = 'pytest -q';
    if (await has('ruff.toml')) checks.lint = 'ruff check .';
  }
  return checks;
}

export function configRoutes(ctx: AppContext): Router {
  const r = Router();

  /* ------------------------------------------------------------------ repos */
  r.get('/repos', async (_req, res) => {
    res.json(await RepoModel.find().sort({ name: 1 }).lean());
  });
  r.get('/repos/:id', async (req, res) => {
    res.json((await RepoModel.findById(oid(param(req.params.id))).lean()) ?? notFound('Repository'));
  });
  r.post('/repos', async (req, res) => {
    const input = RepoSchema.parse(req.body);
    if (input.source === 'local') {
      const info = await validateLocalRepo(input.localPath!);
      input.localPath = info.root;
      if (!req.body.defaultBranch && info.currentBranch && info.currentBranch !== 'HEAD') input.defaultBranch = info.currentBranch;
    }
    const doc = await RepoModel.create(input);
    if (input.source === 'git') {
      try {
        const ref = { ...doc.toObject(), _id: String(doc._id) } as unknown as RepoRef;
        const root = await repoRoot(ref);
        if (!req.body.defaultBranch) {
          const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root, { allowFail: true });
          if (head.code === 0) doc.defaultBranch = head.output.trim().replace(/^origin\//, '');
        }
        doc.lastSyncedAt = new Date();
        await doc.save();
      } catch (e) {
        await RepoModel.deleteOne({ _id: doc._id });
        throw new HttpError(400, `Clone failed: ${(e as Error).message}`);
      }
    }
    res.status(201).json(doc.toObject());
  });
  r.put('/repos/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const input = RepoSchema.parse(req.body);
    if (input.source === 'local') input.localPath = (await validateLocalRepo(input.localPath!)).root;
    const doc = await RepoModel.findByIdAndUpdate(id, { $set: input }, { returnDocument: 'after' }).lean();
    res.json(doc ?? notFound('Repository'));
  });
  r.delete('/repos/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    if (await RunModel.exists({ repoId: id, status: { $in: ACTIVE } })) throw new HttpError(409, 'Repository has active runs');
    const repo = await RepoModel.findById(id).lean();
    if (!repo) notFound('Repository');
    await RepoModel.deleteOne({ _id: id });
    if (repo.source === 'git') await fs.rm(clonePathFor(id), { recursive: true, force: true });
    res.status(204).end();
  });
  r.post('/repos/:id/sync', async (req, res) => {
    const id = oid(param(req.params.id));
    const repo = await RepoModel.findById(id).lean();
    if (!repo) notFound('Repository');
    try {
      await syncRepo({ ...repo, _id: id } as unknown as RepoRef);
      await RepoModel.updateOne({ _id: id }, { $set: { lastSyncedAt: new Date(), lastError: null } });
    } catch (e) {
      await RepoModel.updateOne({ _id: id }, { $set: { lastError: (e as Error).message } });
      throw new HttpError(400, (e as Error).message);
    }
    res.json(await RepoModel.findById(id).lean());
  });
  r.get('/repos/:id/detect-checks', async (req, res) => {
    const id = oid(param(req.params.id));
    const repo = await RepoModel.findById(id).lean();
    if (!repo) notFound('Repository');
    res.json(await detectChecks(await repoRoot({ ...repo, _id: id } as unknown as RepoRef)));
  });

  /* ----------------------------------------------------------------- skills */
  r.get('/skills', async (_req, res) => {
    res.json(await SkillModel.find().sort({ builtIn: -1, name: 1 }).lean());
  });
  r.post('/skills', async (req, res) => {
    res.status(201).json((await SkillModel.create({ ...SkillSchema.parse(req.body), builtIn: false })).toObject());
  });
  r.put('/skills/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const existing = await SkillModel.findById(id).lean();
    if (!existing) notFound('Skill');
    const input = SkillSchema.parse({ ...req.body, builtIn: existing.builtIn });
    if (input.slug !== existing.slug && (await OperationModel.exists({ skills: existing.slug }))) {
      throw new HttpError(409, 'Cannot rename a skill that operations use');
    }
    res.json(await SkillModel.findByIdAndUpdate(id, { $set: input }, { returnDocument: 'after' }).lean());
  });
  r.post('/skills/:id/reset', async (req, res) => {
    const id = oid(param(req.params.id));
    const s = await SkillModel.findById(id).lean();
    const def = s && builtInDefault('skill', s.slug);
    if (!def) throw new HttpError(400, 'Not a built-in skill');
    res.json(await SkillModel.findByIdAndUpdate(id, { $set: def }, { returnDocument: 'after' }).lean());
  });
  r.delete('/skills/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const s = await SkillModel.findById(id).lean();
    if (!s) notFound('Skill');
    const users = await OperationModel.find({ skills: s.slug }, { key: 1 }).lean();
    if (users.length) throw new HttpError(409, `Skill is used by: ${users.map((u) => u.key).join(', ')}`);
    await SkillModel.deleteOne({ _id: id });
    res.status(204).end();
  });

  /* ------------------------------------------------------------- operations */
  const validateOperation = async (body: unknown, builtIn: boolean) => {
    const op = OperationSchema.parse({ ...(body as object), builtIn });
    const skills = await SkillModel.find({ slug: { $in: op.skills } }, { slug: 1 }).lean();
    const missing = op.skills.filter((s) => !skills.some((k) => k.slug === s));
    if (missing.length) throw new HttpError(400, `Unknown skill(s): ${missing.join(', ')}`);
    if (!ctx.providers.list().some((p) => p.id === op.provider)) throw new HttpError(400, `Unknown provider "${op.provider}"`);
    const problem = modelProblem(op.provider, op.model, (await getSettings()).models);
    if (problem) throw new HttpError(400, problem);
    const ids = new Set<string>();
    for (const g of op.gates) {
      if (ids.has(g.id)) throw new HttpError(400, `Duplicate gate id "${g.id}"`);
      ids.add(g.id);
      if (g.type === 'command' && !g.check && !g.command) throw new HttpError(400, `Command gate "${g.id}" needs a check name or a command`);
    }
    const aIds = new Set<string>();
    for (const a of op.artifacts) {
      if (aIds.has(a.id)) throw new HttpError(400, `Duplicate artifact id "${a.id}"`);
      aIds.add(a.id);
      for (const p of a.requiredPatterns) {
        try {
          new RegExp(p.pattern, 'im');
        } catch {
          throw new HttpError(400, `Invalid pattern in artifact "${a.id}": ${p.pattern}`);
        }
      }
    }
    for (const re of [...op.policy.commandAllowlist, ...op.policy.commandDenylist]) {
      try {
        new RegExp(re, 'i');
      } catch {
        throw new HttpError(400, `Invalid command pattern: ${re}`);
      }
    }
    if (op.gates.some((g) => g.onFail === 'rewind') && !op.rewindTo) {
      throw new HttpError(400, 'A gate uses onFail "rewind" but the operation has no rewindTo stage');
    }
    return op;
  };
  r.get('/operations', async (_req, res) => {
    res.json(await OperationModel.find().sort({ builtIn: -1, name: 1 }).lean());
  });
  r.get('/operations/:id', async (req, res) => {
    res.json((await OperationModel.findById(oid(param(req.params.id))).lean()) ?? notFound('Operation'));
  });
  r.post('/operations', async (req, res) => {
    res.status(201).json((await OperationModel.create(await validateOperation(req.body, false))).toObject());
  });
  r.put('/operations/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const existing = await OperationModel.findById(id).lean();
    if (!existing) notFound('Operation');
    const op = await validateOperation(req.body, existing.builtIn);
    if (op.key !== existing.key && (await PipelineModel.exists({ 'stages.operationKey': existing.key }))) {
      throw new HttpError(409, 'Cannot change the key of an operation that pipelines use');
    }
    res.json(await OperationModel.findByIdAndUpdate(id, { $set: op }, { returnDocument: 'after' }).lean());
  });
  r.post('/operations/:id/duplicate', async (req, res) => {
    const src = await OperationModel.findById(oid(param(req.params.id))).lean();
    if (!src) notFound('Operation');
    let key = `${src.key}-copy`;
    for (let i = 2; await OperationModel.exists({ key }); i++) key = `${src.key}-copy-${i}`;
    const { _id, createdAt, updatedAt, ...rest } = src as Record<string, unknown>;
    void _id;
    void createdAt;
    void updatedAt;
    const doc = await OperationModel.create({ ...rest, key, name: `${src.name} (copy)`, builtIn: false });
    res.status(201).json(doc.toObject());
  });
  r.post('/operations/:id/reset', async (req, res) => {
    const id = oid(param(req.params.id));
    const o = await OperationModel.findById(id).lean();
    const def = o && builtInDefault('operation', o.key);
    if (!def) throw new HttpError(400, 'Not a built-in operation');
    res.json(await OperationModel.findByIdAndUpdate(id, { $set: def }, { returnDocument: 'after' }).lean());
  });
  r.delete('/operations/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const o = await OperationModel.findById(id).lean();
    if (!o) notFound('Operation');
    const users = await PipelineModel.find({ 'stages.operationKey': o.key }, { key: 1 }).lean();
    if (users.length) throw new HttpError(409, `Operation is used by pipeline(s): ${users.map((u) => u.key).join(', ')}`);
    await OperationModel.deleteOne({ _id: id });
    res.status(204).end();
  });

  /* -------------------------------------------------------------- pipelines */
  const validatePipeline = async (body: unknown, builtIn: boolean) => {
    const p = PipelineSchema.parse({ ...(body as object), builtIn });
    const keys = p.stages.map((s) => s.operationKey);
    const ops = await OperationModel.find({ key: { $in: keys } }, { key: 1, name: 1, provider: 1, model: 1 }).lean();
    const missing = keys.filter((k) => !ops.some((o) => o.key === k));
    if (missing.length) throw new HttpError(400, `Unknown operation(s): ${[...new Set(missing)].join(', ')}`);
    const catalog = (await getSettings()).models;
    for (const st of p.stages) {
      const op = ops.find((o) => o.key === st.operationKey)!;
      const provider = st.overrides.provider ?? op.provider;
      if (!ctx.providers.list().some((x) => x.id === provider)) throw new HttpError(400, `Stage "${op.name}": unknown provider "${provider}"`);
      const problem = modelProblem(provider, st.overrides.model ?? op.model, catalog);
      if (problem) throw new HttpError(400, `Stage "${op.name}": ${problem}`);
    }
    if (new Set(keys).size !== keys.length) throw new HttpError(400, 'An operation may appear only once per pipeline');
    for (const re of p.globalPolicy.commandDenylist) {
      try {
        new RegExp(re, 'i');
      } catch {
        throw new HttpError(400, `Invalid command pattern: ${re}`);
      }
    }
    return p;
  };
  r.get('/pipelines', async (_req, res) => {
    res.json(await PipelineModel.find().sort({ builtIn: -1, name: 1 }).lean());
  });
  r.get('/pipelines/:id', async (req, res) => {
    res.json((await PipelineModel.findById(oid(param(req.params.id))).lean()) ?? notFound('Pipeline'));
  });
  r.post('/pipelines', async (req, res) => {
    res.status(201).json((await PipelineModel.create(await validatePipeline(req.body, false))).toObject());
  });
  r.put('/pipelines/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    const existing = await PipelineModel.findById(id).lean();
    if (!existing) notFound('Pipeline');
    const p = await validatePipeline(req.body, existing.builtIn);
    res.json(await PipelineModel.findByIdAndUpdate(id, { $set: p }, { returnDocument: 'after' }).lean());
  });
  r.post('/pipelines/:id/duplicate', async (req, res) => {
    const src = await PipelineModel.findById(oid(param(req.params.id))).lean();
    if (!src) notFound('Pipeline');
    let key = `${src.key}-copy`;
    for (let i = 2; await PipelineModel.exists({ key }); i++) key = `${src.key}-copy-${i}`;
    const { _id, createdAt, updatedAt, ...rest } = src as Record<string, unknown>;
    void _id;
    void createdAt;
    void updatedAt;
    res.status(201).json((await PipelineModel.create({ ...rest, key, name: `${src.name} (copy)`, builtIn: false })).toObject());
  });
  r.post('/pipelines/:id/reset', async (req, res) => {
    const id = oid(param(req.params.id));
    const p = await PipelineModel.findById(id).lean();
    const def = p && builtInDefault('pipeline', p.key);
    if (!def) throw new HttpError(400, 'Not a built-in pipeline');
    res.json(await PipelineModel.findByIdAndUpdate(id, { $set: def }, { returnDocument: 'after' }).lean());
  });
  r.delete('/pipelines/:id', async (req, res) => {
    const id = oid(param(req.params.id));
    if (await ScheduleModel.exists({ pipelineId: id })) throw new HttpError(409, 'Pipeline is used by a schedule');
    await PipelineModel.deleteOne({ _id: id });
    res.status(204).end();
  });

  /* -------------------------------------------------------------- knowledge */
  r.get('/knowledge', async (req, res) => {
    const repoId = typeof req.query.repoId === 'string' ? req.query.repoId : undefined;
    const filter = repoId === 'global' ? { repoId: null } : repoId ? { $or: [{ repoId }, { repoId: null }] } : {};
    res.json(await KnowledgeModel.find(filter).sort({ pinned: -1, updatedAt: -1 }).lean());
  });
  r.post('/knowledge', async (req, res) => {
    res.status(201).json((await KnowledgeModel.create(KnowledgeEntrySchema.parse(req.body))).toObject());
  });
  r.put('/knowledge/:id', async (req, res) => {
    const doc = await KnowledgeModel.findByIdAndUpdate(oid(param(req.params.id)), { $set: KnowledgeEntrySchema.parse(req.body) }, { returnDocument: 'after' }).lean();
    res.json(doc ?? notFound('Knowledge entry'));
  });
  r.delete('/knowledge/:id', async (req, res) => {
    await KnowledgeModel.deleteOne({ _id: oid(param(req.params.id)) });
    res.status(204).end();
  });

  /* -------------------------------------------------------------- schedules */
  const withNext = <T extends { cron: string; enabled?: boolean }>(s: T) => ({ ...s, nextRunAt: s.enabled ? Scheduler.nextRun(s.cron) : null });
  const validateSchedule = async (body: unknown) => {
    const s = ScheduleSchema.parse(body);
    try {
      Scheduler.validate(s.cron);
    } catch (e) {
      throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`);
    }
    if (!(await RepoModel.exists({ _id: oid(s.repoId) }))) throw new HttpError(400, 'Unknown repository');
    if (!(await PipelineModel.exists({ _id: oid(s.pipelineId) }))) throw new HttpError(400, 'Unknown pipeline');
    return s;
  };
  r.get('/schedules', async (_req, res) => {
    res.json((await ScheduleModel.find().sort({ name: 1 }).lean()).map(withNext));
  });
  r.post('/schedules', async (req, res) => {
    const doc = await ScheduleModel.create(await validateSchedule(req.body));
    await ctx.scheduler.reload();
    res.status(201).json(withNext(doc.toObject()));
  });
  r.put('/schedules/:id', async (req, res) => {
    const doc = await ScheduleModel.findByIdAndUpdate(oid(param(req.params.id)), { $set: await validateSchedule(req.body) }, { returnDocument: 'after' }).lean();
    await ctx.scheduler.reload();
    res.json(doc ? withNext(doc) : notFound('Schedule'));
  });
  r.post('/schedules/:id/run-now', async (req, res) => {
    const run = await ctx.scheduler.fire(oid(param(req.params.id)));
    res.status(201).json(run ?? notFound('Schedule'));
  });
  r.delete('/schedules/:id', async (req, res) => {
    await ScheduleModel.deleteOne({ _id: oid(param(req.params.id)) });
    await ctx.scheduler.reload();
    res.status(204).end();
  });

  return r;
}
