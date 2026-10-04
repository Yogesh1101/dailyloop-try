import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactContractSchema, OperationSchema, type StageArtifact } from '@harness/shared';
import { evaluateAssertion, selectPath, validateArtifact } from '../src/engine/artifacts';
import { evaluateGates, failureReport } from '../src/engine/gates';
import { makeRepo } from './helpers';

const md = (over: object = {}) =>
  ArtifactContractSchema.parse({ id: 'spec', path: 'spec.md', format: 'markdown', requiredHeadings: ['Goals', 'Acceptance Criteria'], minChars: 20, ...over });

describe('artifact contracts', () => {
  it('requires every heading with real content', () => {
    expect(validateArtifact(md(), '## Goals\nShip it well.\n## Acceptance Criteria\nAC-1 works.').valid).toBe(true);
    const missing = validateArtifact(md(), '## Goals\nShip it well and more text here.');
    expect(missing.errors.join()).toContain('Missing required section heading "Acceptance Criteria"');
    const empty = validateArtifact(md(), '## Goals\n\n## Acceptance Criteria\nAC-1 works fine here.');
    expect(empty.errors.join()).toContain('Required section "Goals" is empty');
  });

  it('ignores headings inside code fences', () => {
    const v = validateArtifact(md(), '## Goals\nreal\n```\n## Acceptance Criteria\n```\n');
    expect(v.errors.join()).toContain('Acceptance Criteria');
  });

  it('rejects placeholders, enforces patterns and length', () => {
    expect(validateArtifact(md(), '## Goals\nTBD\n## Acceptance Criteria\nAC-1 later.').errors.join()).toContain('placeholder');
    const pat = md({ requiredPatterns: [{ pattern: '\\bAC-\\d+\\b', description: 'numbered criteria' }] });
    expect(validateArtifact(pat, '## Goals\nShip it.\n## Acceptance Criteria\nIt works.').errors.join()).toContain('numbered criteria');
    expect(validateArtifact(md({ minChars: 500 }), '## Goals\nx\n## Acceptance Criteria\ny').errors.join()).toContain('at least 500');
    expect(validateArtifact(md(), null).errors[0]).toContain('Missing artifact file');
  });

  it('validates JSON against its schema', () => {
    const c = ArtifactContractSchema.parse({
      id: 'plan_json',
      path: 'plan.json',
      format: 'json',
      jsonSchema: { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', minItems: 1 } } },
    });
    expect(validateArtifact(c, '{"tasks":[{"id":"T1"}]}').valid).toBe(true);
    expect(validateArtifact(c, '{"tasks":[]}').valid).toBe(false);
    expect(validateArtifact(c, '{not json').errors[0]).toContain('not valid JSON');
  });

  it('selects paths with flattening and filters', () => {
    const doc = { tasks: [{ files: ['a.ts', 'b.ts'] }, { files: ['c.ts'] }], findings: [{ severity: 'blocker' }, { severity: 'nit' }, { severity: 'blocker' }], verdict: 'approve' };
    expect(selectPath(doc, 'tasks[].files').flat()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(evaluateAssertion(doc, { path: 'findings[?severity==blocker]', op: 'count_eq', value: 0, message: '' })).toEqual({ passed: false, actual: 2 });
    expect(evaluateAssertion(doc, { path: 'findings[?severity==major]', op: 'count_eq', value: 0, message: '' }).passed).toBe(true);
    expect(evaluateAssertion(doc, { path: 'verdict', op: 'eq', value: 'approve', message: '' }).passed).toBe(true);
    expect(evaluateAssertion(doc, { path: 'findings', op: 'count_lte', value: 3, message: '' }).passed).toBe(true);
  });
});

describe('gates', () => {
  const AD = '.harness/runs/r1';
  const plan: StageArtifact = { id: 'plan_json', path: `${AD}/plan.json`, format: 'json', valid: true, errors: [], content: JSON.stringify({ tasks: [{ files: ['src/app.js'] }] }) };
  const op = (gates: unknown[], artifacts: unknown[] = []) =>
    OperationSchema.parse({ key: 'implement', name: 'Implement', instructions: 'x', policy: {}, artifacts, gates });
  const write = (root: string, p: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };

  it('diff_scope passes inside the plan and fails outside it', async () => {
    const { root, base } = makeRepo();
    const o = op([{ id: 'scope', name: 'Scope', type: 'diff_scope', alwaysAllowed: ['package-lock.json'] }]);
    const ctx = { op: o, worktree: root, artifactsDir: AD, baseCommit: base, repoChecks: {}, priorArtifacts: new Map([['plan_json', plan]]), attempt: 1 };
    write(root, 'src/app.js', 'changed');
    write(root, `${AD}/notes.md`, 'harness files never count');
    write(root, 'package-lock.json', '{}');
    expect((await evaluateGates(ctx)).passed).toBe(true);
    write(root, 'src/other.js', 'not in plan');
    const ev = await evaluateGates(ctx);
    expect(ev.passed).toBe(false);
    expect(ev.onFail).toBe('retry');
    expect(failureReport(ev.results)).toContain('src/other.js');
  });

  it('command gates pass, fail, and skip optional missing checks', async () => {
    const { root, base } = makeRepo();
    const o = op([
      { id: 'ok', name: 'OK', type: 'command', command: 'true' },
      { id: 'lint', name: 'Lint', type: 'command', check: 'lint', required: false },
    ]);
    const ctx = { op: o, worktree: root, artifactsDir: AD, baseCommit: base, repoChecks: {}, priorArtifacts: new Map(), attempt: 1 };
    const ev = await evaluateGates(ctx);
    expect(ev.passed).toBe(true);
    expect(ev.results[1].message).toContain('Skipped');
    const failing = op([{ id: 'tests', name: 'Tests', type: 'command', check: 'test', onFail: 'halt' }]);
    const ev2 = await evaluateGates({ ...ctx, op: failing, repoChecks: { test: 'echo boom && exit 3' } });
    expect(ev2.passed).toBe(false);
    expect(ev2.onFail).toBe('halt');
    expect(ev2.results[0].output).toContain('boom');
    const missing = await evaluateGates({ ...ctx, op: op([{ id: 'tests', name: 'Tests', type: 'command', check: 'test' }]) });
    expect(missing.results[0].message).toContain('no "test" check configured');
  });

  it('opens the human gate only after every automated gate passes', async () => {
    const { root, base } = makeRepo();
    const contract = { id: 'review_json', path: 'review.json', format: 'json' };
    const o = op(
      [
        { id: 'contracts', name: 'Contracts', type: 'artifacts' },
        { id: 'verdict', name: 'Verdict', type: 'json_assert', artifact: 'review_json', onFail: 'rewind', assertions: [{ path: 'verdict', op: 'eq', value: 'approve', message: 'must approve' }] },
        { id: 'human', name: 'Human', type: 'human_approval' },
      ],
      [contract],
    );
    const ctx = { op: o, worktree: root, artifactsDir: AD, baseCommit: base, repoChecks: {}, priorArtifacts: new Map(), attempt: 1 };
    write(root, `${AD}/review.json`, '{"verdict":"request_changes"}');
    const rejected = await evaluateGates(ctx);
    expect(rejected.passed).toBe(false);
    expect(rejected.onFail).toBe('rewind');
    expect(rejected.humanGate).toBeUndefined();
    write(root, `${AD}/review.json`, '{"verdict":"approve"}');
    const ok = await evaluateGates(ctx);
    expect(ok.passed).toBe(true);
    expect(ok.humanGate?.id).toBe('human');
  });
});
