import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { ARTIFACTS_DIR_TOKEN, type GlobalPolicy, type Policy, type ToolName } from '@harness/shared';
import { escapeRegExp } from '../util/misc';

/** Thrown on any guardrail breach. The runner halts the stage and blocks the run. */
export class PolicyViolationError extends Error {
  constructor(
    public rule: string,
    public detail: string,
    public tool?: string,
    public input?: string,
  ) {
    super(`Policy violation [${rule}]: ${detail}`);
  }
}

export interface EffectivePolicy extends Policy {
  /** Artifact paths (repo-relative) owned by the current stage. */
  ownArtifactPaths: string[];
  artifactsDir: string;
}

const expand = (patterns: string[], artifactsDir: string) =>
  patterns.map((p) => p.split(ARTIFACTS_DIR_TOKEN).join(artifactsDir).replace(/^\.\//, ''));

/**
 * Merge an operation's policy with the pipeline's global guardrails.
 * Global forbidden paths and denied commands are always added, never removed.
 */
export function effectivePolicy(
  op: Policy,
  global: GlobalPolicy,
  artifactsDir: string,
  ownArtifactPaths: string[],
): EffectivePolicy {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    ...op,
    writablePaths: uniq(expand(op.writablePaths, artifactsDir)),
    forbiddenPaths: uniq(expand([...global.forbiddenPaths, ...op.forbiddenPaths], artifactsDir)),
    commandDenylist: uniq([...global.commandDenylist, ...op.commandDenylist]),
    commandAllowlist: uniq(op.commandAllowlist),
    ownArtifactPaths,
    artifactsDir,
  };
}

const GLOB_CHARS = /[*?[\]{}()!+@]/;

/** Literal path fragments from forbidden globs, used to catch shell access to forbidden files. */
export function forbiddenLiterals(globs: string[]): { token: string; mode: 'exact' | 'prefix' | 'suffix' }[] {
  const out: { token: string; mode: 'exact' | 'prefix' | 'suffix' }[] = [];
  for (const g of globs) {
    for (const seg of g.split('/')) {
      if (!seg || seg === '**' || seg === '*') continue;
      if (!GLOB_CHARS.test(seg)) {
        if (seg.length >= 3) out.push({ token: seg, mode: 'exact' });
        continue;
      }
      const first = seg.search(GLOB_CHARS);
      const prefix = seg.slice(0, first);
      if (prefix.length >= 4) out.push({ token: prefix, mode: 'prefix' });
      const lastGlob = Math.max(...[...seg].map((c, i) => (GLOB_CHARS.test(c) ? i : -1)));
      const suffix = seg.slice(lastGlob + 1);
      if (suffix.length >= 4 && suffix.startsWith('.')) out.push({ token: suffix, mode: 'suffix' });
    }
  }
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(t.mode + t.token) ? false : (seen.add(t.mode + t.token), true)));
}

export class PolicyEngine {
  private isForbidden: (p: string) => boolean;
  private isWritable: (p: string) => boolean;
  private deny: RegExp[];
  private allow: RegExp[];
  private literalChecks: { token: string; re: RegExp }[];
  private realRoot: string;

  constructor(
    public readonly policy: EffectivePolicy,
    public readonly root: string,
  ) {
    const opts = { dot: true };
    this.isForbidden = policy.forbiddenPaths.length ? picomatch(policy.forbiddenPaths, opts) : () => false;
    this.isWritable = policy.writablePaths.length ? picomatch(policy.writablePaths, opts) : () => false;
    this.deny = policy.commandDenylist.map((r) => new RegExp(r, 'i'));
    this.allow = policy.commandAllowlist.map((r) => new RegExp(r, 'i'));
    const B = `[\\s'"=/<>|;&()\`]`;
    this.literalChecks = forbiddenLiterals(policy.forbiddenPaths).map(({ token, mode }) => {
      const t = escapeRegExp(token);
      const re =
        mode === 'exact'
          ? new RegExp(`(^|${B})${t}($|${B})`)
          : mode === 'prefix'
            ? new RegExp(`(^|${B})${t}`)
            : new RegExp(`${t}($|${B})`);
      return { token, re };
    });
    this.realRoot = fs.realpathSync(root);
  }

  checkTool(name: string): asserts name is ToolName {
    if (!(this.policy.allowedTools as string[]).includes(name)) {
      throw new PolicyViolationError('tool-not-allowed', `Tool "${name}" is not allowed in this operation`, name);
    }
  }

  /** Resolve an agent-supplied path to a normalised repo-relative path, refusing anything outside the worktree. */
  resolve(input: string, tool: string): { rel: string; abs: string } {
    if (typeof input !== 'string' || !input.trim()) {
      throw new PolicyViolationError('invalid-path', 'Empty path', tool, String(input));
    }
    const abs = path.resolve(this.root, input);
    const rel = path.relative(this.root, abs);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new PolicyViolationError('path-escape', `Path "${input}" is outside the worktree`, tool, input);
    }
    // Symlink escape: canonicalise the deepest existing ancestor.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const realRel = path.relative(this.realRoot, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PolicyViolationError('path-escape', `Path "${input}" resolves outside the worktree via a symlink`, tool, input);
    }
    return { rel: rel.split(path.sep).join('/') || '.', abs };
  }

  /** True when the path must be hidden from listings and search results. */
  hidden(rel: string): boolean {
    return rel !== '.' && this.isForbidden(rel);
  }

  checkRead(input: string, tool: string): { rel: string; abs: string } {
    const r = this.resolve(input, tool);
    if (this.hidden(r.rel)) {
      throw new PolicyViolationError('forbidden-path', `"${r.rel}" is a forbidden path (no read or write)`, tool, input);
    }
    return r;
  }

  checkWrite(input: string, tool: string): { rel: string; abs: string } {
    const r = this.checkRead(input, tool);
    // The .harness folder is harness-owned: a stage may write only its own artifact files there.
    const inHarness = r.rel === '.harness' || r.rel.startsWith('.harness/');
    if (inHarness) {
      if (!this.policy.ownArtifactPaths.includes(r.rel)) {
        throw new PolicyViolationError(
          'artifact-immutable',
          `"${r.rel}" is not an artifact of this stage. .harness/ is harness-owned and artifacts of other stages are immutable; this stage may write only: ${this.policy.ownArtifactPaths.join(', ') || '(none)'}`,
          tool,
          input,
        );
      }
      return r;
    }
    if (!this.isWritable(r.rel)) {
      throw new PolicyViolationError(
        'read-only-path',
        `"${r.rel}" is read-only for this operation. Writable: ${this.policy.writablePaths.join(', ') || '(artifacts only)'}`,
        tool,
        input,
      );
    }
    return r;
  }

  checkCommand(command: string): void {
    if (typeof command !== 'string' || !command.trim()) {
      throw new PolicyViolationError('invalid-command', 'Empty command', 'run_command', String(command));
    }
    for (const re of this.deny) {
      if (re.test(command)) {
        throw new PolicyViolationError('command-denied', `Command matches denylist pattern /${re.source}/`, 'run_command', command);
      }
    }
    if (this.allow.length && !this.allow.some((re) => re.test(command))) {
      throw new PolicyViolationError(
        'command-not-allowlisted',
        'Command does not match any allowlisted pattern for this operation',
        'run_command',
        command,
      );
    }
    for (const { token, re } of this.literalChecks) {
      if (re.test(command)) {
        throw new PolicyViolationError(
          'forbidden-path',
          `Command references forbidden path fragment "${token}". Use the file tools; forbidden files are off-limits.`,
          'run_command',
          command,
        );
      }
    }
  }
}
