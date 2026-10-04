import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '@harness/shared';
import { PolicyViolationError } from '../src/engine/policy';
import { ToolExecutor } from '../src/engine/tools';
import { ARTIFACTS, engineFor, makeRepo } from './helpers';

let n = 0;
const call = (name: string, input: unknown) => ({ id: `c${++n}`, name, input });

describe('ToolExecutor', () => {
  it('reads files with line numbers and refuses forbidden ones', async () => {
    const { root } = makeRepo();
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS }), root);
    const r = await ex.execute(call('read_file', { path: 'src/app.js' }));
    expect(r.result.content).toMatch(/^1\texport const add/);
    await expect(ex.execute(call('read_file', { path: '.env' }))).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('hides forbidden files from list_dir and search', async () => {
    const { root } = makeRepo();
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS }), root);
    const list = await ex.execute(call('list_dir', { path: '.', depth: 2 }));
    expect(list.result.content).toContain('src/app.js');
    expect(list.result.content).not.toMatch(/(^|\n)\.env(\n|$)/);
    const found = await ex.execute(call('search', { pattern: 'SECRET|add' }));
    expect(found.result.content).toContain('src/app.js');
    expect(found.result.content).not.toContain('hunter2');
  });

  it('edits only unique matches and reports invalid input as an error result', async () => {
    const { root } = makeRepo();
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS, writablePaths: ['src/**'] }), root);
    fs.writeFileSync(path.join(root, 'src/dup.js'), 'x\nx\n');
    const dup = await ex.execute(call('edit_file', { path: 'src/dup.js', old_string: 'x', new_string: 'y' }));
    expect(dup.result.isError).toBe(true);
    const ok = await ex.execute(call('edit_file', { path: 'src/app.js', old_string: 'a + b', new_string: 'b + a' }));
    expect(ok.wrote).toBe('src/app.js');
    expect(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8')).toContain('b + a');
    const bad = await ex.execute(call('write_file', { path: 'src/x.js' }));
    expect(bad.result.isError).toBe(true);
  });

  it('halts when a shell command writes outside the writable paths', async () => {
    const { root } = makeRepo();
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS, writablePaths: ['src/**', '{{artifactsDir}}/**'] }), root);
    const fine = await ex.execute(call('run_command', { command: 'echo ok > src/generated.txt' }));
    expect(fine.result.content).toContain('exit code: 0');
    const err = await ex.execute(call('run_command', { command: 'echo hacked >> README.md' })).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect((err as PolicyViolationError).detail).toContain('README.md');
  });

  it('runs commands with a scrubbed environment', async () => {
    const { root } = makeRepo();
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak';
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ALL_TOOLS }), root);
    const r = await ex.execute(call('run_command', { command: 'echo "key=$ANTHROPIC_API_KEY"' }));
    expect(r.result.content).toContain('key=\n');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('signals finish', async () => {
    const { root } = makeRepo();
    const ex = new ToolExecutor(engineFor(root, { allowedTools: ['finish'] }, [`${ARTIFACTS}/report.md`]), root);
    const r = await ex.execute(call('finish', { summary: 'done' }));
    expect(r.finished).toEqual({ summary: 'done' });
  });
});
