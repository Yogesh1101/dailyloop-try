import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_COMMAND_DENYLIST, DEFAULT_FORBIDDEN_PATHS, PolicySchema, type Policy } from '@harness/shared';
import { effectivePolicy, PolicyEngine } from '../src/engine/policy';

/** A throwaway git repo: src/app.js, test/app.test.js, .env, README.md, one commit. */
export function makeRepo(): { root: string; base: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  const w = (p: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  w('src/app.js', 'export const add = (a, b) => a + b;\n');
  w('test/app.test.js', "import test from 'node:test';\n");
  w('.env', 'SECRET=hunter2\n');
  w('README.md', '# demo\n');
  w('.gitignore', 'node_modules/\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { root, base: git('rev-parse', 'HEAD') };
}

export const ARTIFACTS = '.harness/runs/test-run';

export function engineFor(root: string, policy: Partial<Policy>, own: string[] = [`${ARTIFACTS}/report.md`]) {
  const eff = effectivePolicy(
    PolicySchema.parse(policy),
    { forbiddenPaths: DEFAULT_FORBIDDEN_PATHS, commandDenylist: DEFAULT_COMMAND_DENYLIST },
    ARTIFACTS,
    own,
  );
  return new PolicyEngine(eff, root);
}
