import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { OperationSchema, PipelineSchema, SkillSchema, type Operation } from '@harness/shared';
import { KnowledgeModel, OperationModel, PipelineModel, RepoModel, RunModel, SkillModel, UsageRecordModel } from '../db/models';
import { getSettings, monthSpend, updateSettings } from '../engine/settings';
import { effectivePolicy } from '../engine/policy';
import { buildSystemPrompt } from '../engine/prompt';
import { artifactRepoPath } from '../engine/gates';
import { repoRoot, type RepoRef } from '../engine/workspace';
import { buildClaudeCodeExport } from '../export/claudeCode';
import { HttpError, startOfMonth } from '../util/misc';
import type { AppContext } from './context';
import { notFound, oid } from './util';

const ExportSchema = z.object({
  pipelineId: z.string().min(1),
  repoId: z.string().optional(),
  overwrite: z.boolean().default(false),
});

export function systemRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/health', (_req, res) => res.json({ ok: true }));

  r.get('/providers', (_req, res) => {
    res.json(ctx.providers.list().map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured(), configHint: p.configHint })));
  });

  r.get('/settings', async (_req, res) => res.json(await getSettings()));
  r.put('/settings', async (req, res) => res.json(await updateSettings(req.body)));

  /** System prompt preview for an operation, as it would appear in a pipeline. */
  r.post('/operations/preview', async (req, res) => {
    const op = OperationSchema.parse(req.body.operation);
    const pipelineDoc = req.body.pipelineId ? await PipelineModel.findById(oid(req.body.pipelineId)).lean() : await PipelineModel.findOne({ 'stages.operationKey': op.key }).lean();
    const pipeline = PipelineSchema.parse(pipelineDoc ?? { key: 'preview', name: 'Preview', stages: [{ operationKey: op.key }] });
    const skills = await SkillModel.find({ slug: { $in: op.skills } }).lean();
    const artifactsDir = '.harness/runs/<run-id>';
    const policy = effectivePolicy(op.policy, pipeline.globalPolicy, artifactsDir, op.artifacts.map((a) => artifactRepoPath(artifactsDir, a.path)));
    const index = Math.max(0, pipeline.stages.findIndex((s) => s.operationKey === op.key));
    res.json({
      system: buildSystemPrompt({
        op,
        skills: op.skills.map((s) => skills.find((k) => k.slug === s)).filter(Boolean).map((s) => SkillSchema.parse(s)),
        pipeline: { pipelineId: '', key: pipeline.key, name: pipeline.name, constitution: pipeline.constitution, globalPolicy: pipeline.globalPolicy, maxRunCostUsd: pipeline.maxRunCostUsd, captureKnowledge: pipeline.captureKnowledge },
        policy,
        artifactsDir,
        stageIndex: index,
        stageCount: pipeline.stages.length,
        stageNames: pipeline.stages.map((s) => s.operationKey),
        knowledge: [{ type: 'note', title: '(knowledge base entries are retrieved per run)', content: 'Pinned and relevant entries appear here at run time.', pinned: false }],
        repoChecks: { test: '<repo test check>', lint: '<repo lint check>', typecheck: '<repo typecheck check>', build: '<repo build check>' },
      }),
    });
  });

  /* ------------------------------------------------------------------ usage */
  r.get('/usage/summary', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    const rows = await UsageRecordModel.find({ ts: { $gte: from } }).lean();
    const tokens = (r: (typeof rows)[number]) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    const group = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, { key: string; costUsd: number; tokens: number; turns: number }>();
      for (const row of rows) {
        const k = key(row) || 'unknown';
        const g = m.get(k) ?? { key: k, costUsd: 0, tokens: 0, turns: 0 };
        g.costUsd += row.costUsd ?? 0;
        g.tokens += tokens(row);
        g.turns += 1;
        m.set(k, g);
      }
      return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
    };
    const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const byDayMap = new Map(group((r) => dayKey(new Date(r.ts as Date))).map((g) => [g.key, g]));
    const byDay = Array.from({ length: days }, (_, i) => {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      const k = dayKey(d);
      return byDayMap.get(k) ?? { key: k, costUsd: 0, tokens: 0, turns: 0 };
    });
    const runIds = [...new Set(rows.map((r) => r.runId).filter(Boolean))];
    const runCost = group((r) => r.runId ?? '').slice(0, 10);
    const runDocs = await RunModel.find({ _id: { $in: runCost.map((x) => x.key).filter((k) => k !== 'unknown') } }, { title: 1, status: 1, repoName: 1 }).lean();
    const settings = await getSettings();
    res.json({
      days,
      totals: {
        costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
        tokens: rows.reduce((s, r) => s + tokens(r), 0),
        inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
        outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
        cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
        turns: rows.length,
        runs: runIds.length,
      },
      month: { spentUsd: await monthSpend(), budgetUsd: settings.monthlyBudgetUsd, since: startOfMonth().toISOString() },
      byDay,
      byOperation: group((r) => r.operationKey ?? ''),
      byModel: group((r) => r.model ?? ''),
      byRepo: group((r) => r.repoName ?? ''),
      topRuns: runCost.map((g) => {
        const d = runDocs.find((x) => String(x._id) === g.key);
        return { ...g, title: d?.title ?? '(deleted run)', status: d?.status ?? 'unknown', repoName: d?.repoName ?? '' };
      }),
    });
  });

  /* ----------------------------------------------------------------- export */
  const buildExport = async (pipelineId: string, repoId?: string) => {
    const pipelineDoc = (await PipelineModel.findById(oid(pipelineId)).lean()) ?? notFound('Pipeline');
    const pipeline = PipelineSchema.parse(pipelineDoc);
    const operations: Operation[] = [];
    for (const s of pipeline.stages) {
      const doc = await OperationModel.findOne({ key: s.operationKey }).lean();
      if (!doc) throw new HttpError(400, `Unknown operation ${s.operationKey}`);
      operations.push(OperationSchema.parse(doc));
    }
    const skills = (await SkillModel.find().lean()).map((s) => SkillSchema.parse(s));
    const repoDoc = repoId ? await RepoModel.findById(oid(repoId)).lean() : null;
    const knowledge = await KnowledgeModel.find({ pinned: true, $or: [{ repoId: repoId ?? null }, { repoId: null }] }).lean();
    const files = buildClaudeCodeExport({
      pipeline,
      operations,
      skills,
      repo: repoDoc ? { name: repoDoc.name, checks: (repoDoc.checks ?? {}) as Record<string, string> } : undefined,
      knowledge: knowledge.map((k) => ({ type: k.type, title: k.title, content: k.content })),
    });
    return { files, repoDoc };
  };

  r.post('/export/preview', async (req, res) => {
    const input = ExportSchema.parse(req.body);
    const { files } = await buildExport(input.pipelineId, input.repoId);
    res.json({ files });
  });

  /** Write the export into the repository working copy. Existing files are only replaced with overwrite=true. */
  r.post('/export/write', async (req, res) => {
    const input = ExportSchema.parse(req.body);
    if (!input.repoId) throw new HttpError(400, 'repoId is required to write an export');
    const { files, repoDoc } = await buildExport(input.pipelineId, input.repoId);
    if (!repoDoc) notFound('Repository');
    const root = await repoRoot({ ...repoDoc, _id: String(repoDoc._id) } as unknown as RepoRef);
    const conflicts: string[] = [];
    for (const f of files) if (await fs.stat(path.join(root, f.path)).catch(() => null)) conflicts.push(f.path);
    if (conflicts.length && !input.overwrite) {
      return res.status(409).json({ error: 'Files already exist; confirm overwrite', conflicts });
    }
    for (const f of files) {
      const abs = path.join(root, f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content, { mode: f.path.endsWith('.mjs') ? 0o755 : 0o644 });
    }
    res.json({ root, written: files.map((f) => f.path), overwritten: conflicts });
  });

  r.get('/stats', async (_req, res) => {
    const [repos, pipelines, operations, skills, active, awaiting, blocked] = await Promise.all([
      RepoModel.countDocuments(),
      PipelineModel.countDocuments(),
      OperationModel.countDocuments(),
      SkillModel.countDocuments(),
      RunModel.countDocuments({ status: { $in: ['queued', 'running'] } }),
      RunModel.countDocuments({ status: 'awaiting_approval' }),
      RunModel.countDocuments({ status: { $in: ['blocked', 'error'] } }),
    ]);
    res.json({ repos, pipelines, operations, skills, active, awaiting, blocked, monthSpend: await monthSpend(), settings: await getSettings() });
  });

  return r;
}
