import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import type {
  CommandGate,
  DiffScopeGate,
  Gate,
  GateResult,
  HumanApprovalGate,
  JsonAssertGate,
  Operation,
  StageArtifact,
} from '@harness/shared';
import { runShell, safeEnv } from '../util/exec';
import { nowIso } from '../util/misc';
import { evaluateAssertion, selectPath, validateArtifact } from './artifacts';
import { changedFiles } from './workspace';

const ORDER: Record<Gate['type'], number> = { artifacts: 0, json_assert: 1, diff_scope: 2, command: 3, human_approval: 4 };
const SEVERITY = { retry: 0, rewind: 1, halt: 2 } as const;

export interface GateContext {
  op: Operation;
  worktree: string;
  artifactsDir: string;
  baseCommit: string;
  repoChecks: Record<string, string>;
  /** Latest valid artifact per id from earlier stages. */
  priorArtifacts: Map<string, StageArtifact>;
  attempt: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface GateEvaluation {
  artifacts: StageArtifact[];
  results: GateResult[];
  passed: boolean;
  /** Most severe failure action across failed gates. */
  onFail?: 'retry' | 'rewind' | 'halt';
  humanGate?: HumanApprovalGate;
}

export function artifactRepoPath(artifactsDir: string, artifactPath: string): string {
  return `${artifactsDir}/${artifactPath.replace(/^\.?\//, '')}`;
}

/** Read every artifact the operation declares and validate it against its contract. */
export async function collectArtifacts(op: Operation, worktree: string, artifactsDir: string): Promise<StageArtifact[]> {
  const out: StageArtifact[] = [];
  for (const c of op.artifacts) {
    const rel = artifactRepoPath(artifactsDir, c.path);
    const content = await fs.readFile(path.join(worktree, rel), 'utf8').catch(() => null);
    const v = validateArtifact(c, content);
    out.push({ id: c.id, path: rel, format: c.format, content: content ?? '', valid: v.valid, errors: v.errors });
  }
  return out;
}

export async function evaluateGates(ctx: GateContext): Promise<GateEvaluation> {
  const artifacts = await collectArtifacts(ctx.op, ctx.worktree, ctx.artifactsDir);
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const gates = ctx.op.gates.filter((g) => g.enabled).sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  const results: GateResult[] = [];
  let onFail: GateEvaluation['onFail'];
  let humanGate: HumanApprovalGate | undefined;

  const record = (g: Gate, passed: boolean, message: string, output?: string) => {
    results.push({ gateId: g.id, name: g.name, type: g.type, passed, message, output, attempt: ctx.attempt, at: nowIso() });
    if (!passed && g.type !== 'human_approval') {
      if (!onFail || SEVERITY[g.onFail] > SEVERITY[onFail]) onFail = g.onFail;
    }
  };

  for (const g of gates) {
    if (ctx.signal?.aborted) break;
    switch (g.type) {
      case 'artifacts': {
        const bad = artifacts.filter((a) => !a.valid);
        record(
          g,
          bad.length === 0,
          bad.length === 0 ? `All ${artifacts.length} artifact(s) satisfy their contracts.` : `${bad.length} artifact(s) violate their contracts.`,
          bad.flatMap((a) => a.errors.map((e) => `- ${e}`)).join('\n') || undefined,
        );
        break;
      }
      case 'json_assert':
        evaluateJsonAssert(g, byId, ctx.priorArtifacts, record);
        break;
      case 'diff_scope':
        await evaluateDiffScope(g, ctx, record);
        break;
      case 'command':
        ctx.onProgress?.(`Running gate "${g.name}"`);
        await evaluateCommand(g, ctx, record);
        break;
      case 'human_approval':
        humanGate = g;
        break;
    }
  }
  const automatedPassed = results.every((r) => r.passed);
  return { artifacts, results, passed: automatedPassed, onFail: automatedPassed ? undefined : onFail, humanGate: automatedPassed ? humanGate : undefined };
}

type Recorder = (g: Gate, passed: boolean, message: string, output?: string) => void;

function evaluateJsonAssert(
  g: JsonAssertGate,
  current: Map<string, StageArtifact>,
  prior: Map<string, StageArtifact>,
  record: Recorder,
) {
  const art = current.get(g.artifact) ?? prior.get(g.artifact);
  if (!art || !art.valid) {
    record(g, false, `Artifact "${g.artifact}" is missing or invalid; assertions cannot be evaluated.`);
    return;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(art.content);
  } catch {
    record(g, false, `Artifact "${g.artifact}" is not JSON.`);
    return;
  }
  const failures: string[] = [];
  for (const a of g.assertions) {
    try {
      const r = evaluateAssertion(doc, a);
      if (!r.passed) failures.push(`- ${a.message} (path \`${a.path}\` ${a.op} ${JSON.stringify(a.value ?? null)}; actual ${JSON.stringify(r.actual)})`);
    } catch (e) {
      failures.push(`- Invalid assertion on \`${a.path}\`: ${(e as Error).message}`);
    }
  }
  record(
    g,
    failures.length === 0,
    failures.length === 0 ? `All ${g.assertions.length} assertion(s) hold.` : `${failures.length} assertion(s) failed.`,
    failures.length ? `${failures.join('\n')}\n\nArtifact ${art.path}:\n${art.content.slice(0, 6000)}` : undefined,
  );
}

async function evaluateDiffScope(g: DiffScopeGate, ctx: GateContext, record: Recorder) {
  const plan = ctx.priorArtifacts.get(g.planArtifact);
  if (!plan || !plan.valid) {
    record(g, false, `Approved plan artifact "${g.planArtifact}" not found. A diff-scope gate needs an earlier stage that produced it.`);
    return;
  }
  let allowed: string[];
  try {
    allowed = selectPath(JSON.parse(plan.content), g.filesPath)
      .flat()
      .filter((x): x is string => typeof x === 'string')
      .map((f) => f.replace(/^\.\//, ''));
  } catch (e) {
    record(g, false, `Cannot read files from plan (${g.filesPath}): ${(e as Error).message}`);
    return;
  }
  const changed = (await changedFiles(ctx.worktree, ctx.baseCommit)).filter((f) => !f.startsWith('.harness/'));
  const matcher = picomatch([...allowed, ...g.alwaysAllowed], { dot: true });
  const outOfScope = changed.filter((f) => !allowed.includes(f) && !matcher(f));
  const problems: string[] = [];
  if (outOfScope.length) problems.push(`Files changed outside the approved plan:\n${outOfScope.map((f) => `- ${f}`).join('\n')}`);
  if (g.maxFilesChanged && changed.length > g.maxFilesChanged) {
    problems.push(`${changed.length} files changed; the limit is ${g.maxFilesChanged}.`);
  }
  record(
    g,
    problems.length === 0,
    problems.length === 0
      ? `${changed.length} changed file(s), all within the approved plan.`
      : `Diff exceeds the approved scope. Revert out-of-scope changes, or record them under "Deviations from Plan" for the human instead of making them.`,
    problems.length ? `${problems.join('\n\n')}\n\nApproved files:\n${allowed.map((f) => `- ${f}`).join('\n')}` : undefined,
  );
}

async function evaluateCommand(g: CommandGate, ctx: GateContext, record: Recorder) {
  const command = g.check ? ctx.repoChecks[g.check] : g.command;
  if (!command?.trim()) {
    if (g.check && !g.required) {
      record(g, true, `Skipped: the repository has no "${g.check}" check configured (gate is optional).`);
    } else {
      record(
        g,
        false,
        g.check
          ? `The repository has no "${g.check}" check configured. Add it under Repos → Checks, or make this gate optional.`
          : 'Gate has no command configured.',
      );
    }
    return;
  }
  const res = await runShell(command, {
    cwd: ctx.worktree,
    timeoutMs: g.timeoutSeconds * 1000,
    env: safeEnv(),
    maxOutputBytes: 16 * 1024,
    signal: ctx.signal,
  });
  const passed = res.code === g.expectExitCode;
  record(
    g,
    passed,
    passed
      ? `\`${command}\` exited ${res.code}.`
      : `\`${command}\` exited ${res.code}${res.timedOut ? ' (timed out)' : ''}; expected ${g.expectExitCode}.`,
    res.output.trim() || undefined,
  );
}

/** Human-readable failure report fed back to the agent (retry) or an earlier stage (rewind). */
export function failureReport(results: GateResult[]): string {
  return results
    .filter((r) => !r.passed)
    .map((r) => `### Gate failed: ${r.name} (${r.type})\n${r.message}${r.output ? `\n\n\`\`\`\n${r.output.slice(0, 12_000)}\n\`\`\`` : ''}`)
    .join('\n\n');
}
