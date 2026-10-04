import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { runProcess, safeEnv } from '../util/exec';
import { slugify } from '../util/misc';

export interface RepoRef {
  _id: string;
  name: string;
  source: 'local' | 'git';
  localPath?: string;
  gitUrl?: string;
  authTokenEnv?: string;
  defaultBranch: string;
}

export class GitError extends Error {}

const HARNESS_AUTHOR = ['-c', 'user.name=Agentic Harness', '-c', 'user.email=harness@localhost'];

function authArgs(repo: RepoRef): string[] {
  const token = repo.authTokenEnv ? process.env[repo.authTokenEnv] : undefined;
  if (!token) return [];
  // Passed per-invocation so the token is never written to .git/config.
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export async function git(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; allowFail?: boolean; pre?: string[] } = {},
): Promise<{ code: number; output: string }> {
  const res = await runProcess('git', [...(opts.pre ?? []), ...args], {
    cwd,
    timeoutMs: opts.timeoutMs ?? 120_000,
    env: safeEnv(),
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (res.code !== 0 && !opts.allowFail) {
    throw new GitError(`git ${args.join(' ')} failed (${res.code}): ${res.output.trim().slice(0, 2000)}`);
  }
  return { code: res.code, output: res.output };
}

export function clonePathFor(repoId: string): string {
  return path.join(config.dataDir, 'repos', repoId);
}

export function worktreePathFor(runId: string): string {
  return path.join(config.dataDir, 'worktrees', runId);
}

export function artifactsDirFor(runId: string): string {
  return `.harness/runs/${runId}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Validate a local working copy: absolute path, existing, a git repository root or inside one. */
export async function validateLocalRepo(localPath: string): Promise<{ root: string; currentBranch: string }> {
  if (!path.isAbsolute(localPath)) throw new GitError('localPath must be an absolute path');
  if (!(await exists(localPath))) throw new GitError(`Path does not exist: ${localPath}`);
  const top = await git(['rev-parse', '--show-toplevel'], localPath, { allowFail: true });
  if (top.code !== 0) throw new GitError(`Not a git repository: ${localPath}. Run "git init" and commit first.`);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], localPath, { allowFail: true });
  return { root: top.output.trim(), currentBranch: branch.output.trim() };
}

/** Root of the repository the harness works from (the user's checkout, or the harness clone). */
export async function repoRoot(repo: RepoRef): Promise<string> {
  if (repo.source === 'local') return (await validateLocalRepo(repo.localPath!)).root;
  const dir = clonePathFor(repo._id);
  if (!(await exists(path.join(dir, '.git')))) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await git(['clone', '--no-tags', repo.gitUrl!, dir], config.dataDir, {
      pre: authArgs(repo),
      timeoutMs: 15 * 60_000,
    });
  }
  return dir;
}

export async function syncRepo(repo: RepoRef): Promise<string> {
  const root = await repoRoot(repo);
  if (repo.source === 'git') {
    await git(['fetch', '--prune', 'origin'], root, { pre: authArgs(repo), timeoutMs: 10 * 60_000 });
  }
  return root;
}

export interface PreparedWorkspace {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

/** Create an isolated worktree on a fresh branch for one run. The user's checkout is never modified. */
export async function prepareWorktree(repo: RepoRef, runId: string, title: string): Promise<PreparedWorkspace> {
  const root = await syncRepo(repo);
  const baseRef = repo.source === 'git' ? `origin/${repo.defaultBranch}` : repo.defaultBranch;
  const rev = await git(['rev-parse', '--verify', `${baseRef}^{commit}`], root, { allowFail: true });
  if (rev.code !== 0) {
    throw new GitError(`Base branch "${baseRef}" not found in ${repo.name}. Fix the repo's default branch.`);
  }
  const baseCommit = rev.output.trim();
  const branch = `harness/${slugify(title, 40)}-${runId.slice(-6)}`;
  const worktreePath = worktreePathFor(runId);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  if (await exists(worktreePath)) {
    await git(['worktree', 'remove', '--force', worktreePath], root, { allowFail: true });
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  await git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], root);
  await fs.mkdir(path.join(worktreePath, artifactsDirFor(runId)), { recursive: true });
  return { worktreePath, branch, baseBranch: repo.defaultBranch, baseCommit };
}

/** Re-create the worktree for an existing run branch (after cleanup or a lost data dir). */
export async function reattachWorktree(repo: RepoRef, runId: string, branch: string, baseCommit: string, title: string): Promise<PreparedWorkspace> {
  const root = await syncRepo(repo);
  const has = await git(['rev-parse', '--verify', `refs/heads/${branch}`], root, { allowFail: true });
  if (has.code !== 0) return prepareWorktree(repo, runId, title);
  const worktreePath = worktreePathFor(runId);
  await git(['worktree', 'prune'], root, { allowFail: true });
  await fs.rm(worktreePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(['worktree', 'add', worktreePath, branch], root);
  await fs.mkdir(path.join(worktreePath, artifactsDirFor(runId)), { recursive: true });
  return { worktreePath, branch, baseBranch: repo.defaultBranch, baseCommit };
}

/** Harness-owned commit of everything in the worktree. Returns the new sha, or null if nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(['add', '-A'], worktree);
  const staged = await git(['diff', '--cached', '--quiet'], worktree, { allowFail: true });
  if (staged.code === 0) return null;
  await git([...HARNESS_AUTHOR, 'commit', '--no-verify', '-q', '-m', message], worktree);
  return (await git(['rev-parse', 'HEAD'], worktree)).output.trim();
}

/** Files changed relative to the base commit: committed, staged, unstaged and untracked. */
export async function changedFiles(worktree: string, baseCommit: string): Promise<string[]> {
  const tracked = await git(['diff', '--name-only', baseCommit], worktree);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], worktree);
  const all = new Set(
    [...tracked.output.split('\n'), ...untracked.output.split('\n')].map((s) => s.trim()).filter(Boolean),
  );
  return [...all].sort();
}

export async function diffAgainstBase(worktree: string, baseCommit: string): Promise<{ stat: string; patch: string; untracked: string[] }> {
  const stat = await git(['diff', '--stat', baseCommit], worktree);
  const patch = await git(['diff', '--no-color', baseCommit], worktree);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], worktree);
  return {
    stat: stat.output,
    patch: patch.output,
    untracked: untracked.output.split('\n').filter(Boolean),
  };
}

export async function pushBranch(repo: RepoRef, worktree: string, branch: string): Promise<void> {
  const remote = await git(['remote', 'get-url', 'origin'], worktree, { allowFail: true });
  if (remote.code !== 0) throw new GitError('Repository has no "origin" remote; cannot push.');
  await git(['push', '-u', 'origin', branch], worktree, { pre: authArgs(repo), timeoutMs: 10 * 60_000 });
}

export async function remoteUrl(worktree: string): Promise<string | null> {
  const remote = await git(['remote', 'get-url', 'origin'], worktree, { allowFail: true });
  return remote.code === 0 ? remote.output.trim() : null;
}

export async function removeWorktree(repo: RepoRef, worktreePath: string): Promise<void> {
  try {
    const root = await repoRoot(repo);
    await git(['worktree', 'remove', '--force', worktreePath], root, { allowFail: true });
    await git(['worktree', 'prune'], root, { allowFail: true });
  } finally {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}
