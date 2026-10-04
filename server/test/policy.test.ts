import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forbiddenLiterals, PolicyViolationError } from '../src/engine/policy';
import { ARTIFACTS, engineFor, makeRepo } from './helpers';

const violation = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyViolationError);
    return (e as PolicyViolationError).rule;
  }
  throw new Error('expected a policy violation');
};

describe('PolicyEngine', () => {
  const { root } = makeRepo();

  it('blocks tools that are not allowed', () => {
    const p = engineFor(root, { allowedTools: ['read_file', 'finish'] });
    expect(violation(() => p.checkTool('run_command'))).toBe('tool-not-allowed');
    expect(() => p.checkTool('read_file')).not.toThrow();
  });

  it('forbids secrets and VCS internals for reading', () => {
    const p = engineFor(root, {});
    expect(violation(() => p.checkRead('.env', 'read_file'))).toBe('forbidden-path');
    expect(violation(() => p.checkRead('config/.env.production', 'read_file'))).toBe('forbidden-path');
    expect(violation(() => p.checkRead('.git/config', 'read_file'))).toBe('forbidden-path');
    expect(() => p.checkRead('.env.example', 'read_file')).not.toThrow();
    expect(() => p.checkRead('src/app.js', 'read_file')).not.toThrow();
  });

  it('refuses paths that escape the worktree, including via symlinks', () => {
    const p = engineFor(root, {});
    expect(violation(() => p.checkRead('../outside.txt', 'read_file'))).toBe('path-escape');
    expect(violation(() => p.checkRead('/etc/passwd', 'read_file'))).toBe('path-escape');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(violation(() => p.checkRead('link/x.txt', 'read_file'))).toBe('path-escape');
  });

  it('enforces writable paths and artifact immutability', () => {
    const p = engineFor(root, { writablePaths: ['src/**', '{{artifactsDir}}/**'] });
    expect(() => p.checkWrite('src/new.js', 'write_file')).not.toThrow();
    expect(violation(() => p.checkWrite('README.md', 'write_file'))).toBe('read-only-path');
    expect(() => p.checkWrite(`${ARTIFACTS}/report.md`, 'write_file')).not.toThrow();
    expect(violation(() => p.checkWrite(`${ARTIFACTS}/spec.md`, 'write_file'))).toBe('artifact-immutable');
    expect(violation(() => p.checkWrite('.harness/runs/other/plan.json', 'write_file'))).toBe('artifact-immutable');
  });

  it('applies the command denylist, allowlist and forbidden-path literals', () => {
    const p = engineFor(root, {});
    for (const cmd of ['git push origin main', 'git commit -m x', 'sudo rm x', 'curl https://x.y', 'npm publish', 'rm -rf /', 'printenv']) {
      expect(violation(() => p.checkCommand(cmd))).toBe('command-denied');
    }
    expect(violation(() => p.checkCommand('cat .env'))).toBe('forbidden-path');
    expect(violation(() => p.checkCommand('grep -r SECRET ./.env'))).toBe('forbidden-path');
    for (const cmd of ['npm test', 'git status', 'git diff HEAD', 'cat .gitignore', 'ls -la src']) expect(() => p.checkCommand(cmd)).not.toThrow();

    const strict = engineFor(root, { commandAllowlist: ['^npm test\\b', '^git\\s+diff\\b'] });
    expect(() => strict.checkCommand('npm test')).not.toThrow();
    expect(violation(() => strict.checkCommand('node script.js'))).toBe('command-not-allowlisted');
  });

  it('hides forbidden paths from listings', () => {
    const p = engineFor(root, {});
    expect(p.hidden('.env')).toBe(true);
    expect(p.hidden('src/app.js')).toBe(false);
  });

  it('extracts literal fragments from forbidden globs', () => {
    const lits = forbiddenLiterals(['.git/**', '**/*.pem', '**/id_rsa*', '**/secrets/**']);
    expect(lits).toEqual(
      expect.arrayContaining([
        { token: '.git', mode: 'exact' },
        { token: '.pem', mode: 'suffix' },
        { token: 'id_rsa', mode: 'prefix' },
        { token: 'secrets', mode: 'exact' },
      ]),
    );
  });

  it('never lets an operation drop global guardrails', () => {
    const p = engineFor(root, { forbiddenPaths: ['infra/**'], commandDenylist: ['\\bterraform\\b'] });
    expect(p.policy.forbiddenPaths).toEqual(expect.arrayContaining(['infra/**', '**/.env']));
    expect(violation(() => p.checkCommand('terraform apply'))).toBe('command-denied');
    expect(violation(() => p.checkCommand('git push'))).toBe('command-denied');
  });
});
