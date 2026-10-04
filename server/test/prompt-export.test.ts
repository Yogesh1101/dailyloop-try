import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationSchema, PipelineSchema, SkillSchema } from '@harness/shared';
import { DEFAULT_OPERATIONS } from '../src/defaults/operations';
import { DEFAULT_PIPELINES } from '../src/defaults/pipelines';
import { DEFAULT_SKILLS } from '../src/defaults/skills';
import { effectivePolicy } from '../src/engine/policy';
import { buildStageBrief, buildSystemPrompt } from '../src/engine/prompt';
import { buildClaudeCodeExport } from '../src/export/claudeCode';
import { makeRepo } from './helpers';

const ops = DEFAULT_OPERATIONS.map((o) => OperationSchema.parse(o));
const pipeline = PipelineSchema.parse(DEFAULT_PIPELINES[0]);
const skills = DEFAULT_SKILLS.map((s) => SkillSchema.parse(s));

describe('defaults', () => {
  it('every built-in is valid and internally consistent', () => {
    const keys = new Set(ops.map((o) => o.key));
    for (const p of DEFAULT_PIPELINES) for (const s of PipelineSchema.parse(p).stages) expect(keys.has(s.operationKey)).toBe(true);
    for (const o of ops) {
      for (const s of o.skills) expect(skills.some((k) => k.slug === s)).toBe(true);
      if (o.gates.some((g) => g.onFail === 'rewind')) expect(keys.has(o.rewindTo!)).toBe(true);
      for (const a of o.artifacts) for (const p of a.requiredPatterns) expect(() => new RegExp(p.pattern, 'im')).not.toThrow();
    }
  });
});

describe('system prompt', () => {
  it('states the contract, guardrails, artifacts and gates explicitly', () => {
    const op = ops.find((o) => o.key === 'implement')!;
    const ad = '.harness/runs/abc';
    const policy = effectivePolicy(op.policy, pipeline.globalPolicy, ad, [`${ad}/implementation.md`]);
    const system = buildSystemPrompt({
      op,
      skills: skills.filter((s) => op.skills.includes(s.slug)),
      pipeline: { pipelineId: 'p', key: pipeline.key, name: pipeline.name, constitution: pipeline.constitution, globalPolicy: pipeline.globalPolicy, maxRunCostUsd: 10, captureKnowledge: true },
      policy,
      artifactsDir: ad,
      stageIndex: 3,
      stageCount: 7,
      stageNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      knowledge: [{ type: 'convention', title: 'Use zod', content: 'All input is validated with zod.', pinned: true }],
      repoChecks: { test: 'npm test' },
      baseCommit: 'deadbeef',
    });
    expect(system).toContain('HARNESS CONTRACT — NON-NEGOTIABLE');
    expect(system).toContain('`**/.env`');
    expect(system).toContain(`\`${ad}/implementation.md\``);
    expect(system).toContain('`npm test` must exit 0');
    expect(system).toContain('skipped: the repository has no "lint" check');
    expect(system).toContain('Skill: Scope discipline');
    expect(system).toContain('[convention] Use zod (pinned)');
    expect(system).toContain('Untrusted content');
    const brief = buildStageBrief({ task: 'Add X', title: 'X', repoName: 'r', op, inputs: [], humanNotes: [{ stageKey: 'spec', notes: 'Use floats' }], feedback: 'Gate failed' });
    expect(brief).toContain('[spec] Use floats');
    expect(brief).toContain('Feedback you MUST address');
  });
});

describe('Claude Code export', () => {
  const files = buildClaudeCodeExport({ pipeline, operations: ops, skills, repo: { name: 'demo', checks: { test: 'true' } }, knowledge: [] });

  it('produces commands, skills, settings, hook and gate runner', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.claude/hooks/harness-guard.mjs', '.harness/gates.mjs', '.claude/commands/harness-spec.md', '.claude/skills/spec-writing/SKILL.md']));
    const settings = JSON.parse(files.find((f) => f.path === '.claude/settings.json')!.content);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('harness-guard.mjs');
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
  });

  it('the exported guard and gate runner enforce the contract', () => {
    const { root } = makeRepo();
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
      fs.writeFileSync(path.join(root, f.path), f.content);
    }
    const guard = (tool: string, input: object) =>
      spawnSync('node', ['.claude/hooks/harness-guard.mjs'], { cwd: root, input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, CLAUDE_PROJECT_DIR: root } }).status;
    expect(guard('Read', { file_path: '.env' })).toBe(2);
    expect(guard('Read', { file_path: 'src/app.js' })).toBe(0);
    expect(guard('Bash', { command: 'git push' })).toBe(2);
    expect(guard('Bash', { command: 'node .harness/gates.mjs approve spec t' })).toBe(2);

    const gates = (...args: string[]) => spawnSync('node', ['.harness/gates.mjs', ...args], { cwd: root, encoding: 'utf8' });
    expect(gates('start', 'spec', 'feat-x').status).toBe(1);
    expect(gates('start', 'brainstorm', 'feat-x').status).toBe(0);
    expect(guard('Write', { file_path: 'src/app.js' })).toBe(2);
    expect(gates('check', 'brainstorm', 'feat-x').status).toBe(1);
  });
});
