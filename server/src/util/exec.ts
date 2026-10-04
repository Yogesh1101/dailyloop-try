import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  input?: string;
}

/**
 * Environment for agent commands and gate checks: enough to run toolchains,
 * never the harness's own secrets (API keys, tokens).
 */
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER', 'NODE_OPTIONS', 'GOPATH', 'GOCACHE', 'JAVA_HOME', 'PYTHONPATH', 'VIRTUAL_ENV'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, CI: '1', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', ...extra };
}

/** Keep head and tail of long output so both the command echo and the final error survive. */
export function clip(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  return {
    text: `${text.slice(0, half)}\n\n... [${text.length - maxBytes} characters truncated] ...\n\n${text.slice(-half)}`,
    truncated: true,
  };
}

/** Run a shell command in its own process group; kill the whole group on timeout/abort. */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return runProcess('bash', ['-c', command], opts);
}

export function runProcess(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const max = opts.maxOutputBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? safeEnv(),
      detached: true,
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    let size = 0;
    const collect = (b: Buffer) => {
      // Hold up to 4x the limit, then clip head/tail at the end.
      if (size < max * 4) {
        chunks.push(b.toString('utf8'));
        size += b.length;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    if (opts.input && child.stdin) {
      child.stdin.end(opts.input);
    }

    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: 127, output: String(err), timedOut: false, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const { text, truncated } = clip(chunks.join(''), max);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        output: timedOut ? `${text}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]` : text,
        timedOut,
        truncated,
      });
    });
  });
}
