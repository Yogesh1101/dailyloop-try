import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolName } from '@harness/shared';
import type { ToolCall, ToolResult, ToolSpec } from '../providers/types';
import { runProcess, runShell, safeEnv } from '../util/exec';
import { PolicyEngine, PolicyViolationError } from './policy';

const MAX_READ_CHARS = 120_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'target', 'coverage']);

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the worktree. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based)' },
        limit: { type: 'integer', minimum: 1, maximum: 4000, description: 'Maximum number of lines' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  list_dir: {
    name: 'list_dir',
    description: 'List files and directories (dependency and build folders are skipped). Directories end with "/".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the repository root. Default "."' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Recursion depth. Default 2' },
      },
      additionalProperties: false,
    },
  },
  search: {
    name: 'search',
    description:
      'Search file contents with an extended regular expression (git grep -E). Returns "path:line:text" matches, at most 200.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression' },
        path: { type: 'string', description: 'Limit to this directory or file. Default "."' },
        glob: { type: 'string', description: 'Limit to files matching this glob, e.g. "**/*.ts"' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file with the full given content. Parent directories are created.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace an exact string in an existing file. old_string must match exactly once unless replace_all is true. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including whitespace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  run_command: {
    name: 'run_command',
    description:
      'Run a shell command (bash -c) in the repository root and return exit code and combined output. No network tools, no git state changes, no access to forbidden paths.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  finish: {
    name: 'finish',
    description:
      'Declare this stage complete. Call ONLY after every required artifact is written and verified. Gates run immediately after.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you did, what you verified, and anything the human must know' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
};

const inputs = {
  read_file: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(4000).optional() }),
  list_dir: z.object({ path: z.string().default('.'), depth: z.number().int().min(1).max(5).default(2) }),
  search: z.object({ pattern: z.string().min(1), path: z.string().default('.'), glob: z.string().optional(), ignore_case: z.boolean().optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  edit_file: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
  run_command: z.object({ command: z.string(), timeout_seconds: z.number().int().min(1).max(3600).optional() }),
  finish: z.object({ summary: z.string().min(1) }),
} satisfies Record<ToolName, z.ZodTypeAny>;

export interface ToolOutcome {
  result: ToolResult;
  finished?: { summary: string };
  /** Repo-relative path written by this call. */
  wrote?: string;
}

export class ToolExecutor {
  constructor(
    private policy: PolicyEngine,
    private root: string,
    private signal?: AbortSignal,
  ) {}

  /** Execute one tool call. Throws PolicyViolationError on guardrail breaches; other failures become error results. */
  async execute(call: ToolCall): Promise<ToolOutcome> {
    this.policy.checkTool(call.name);
    const name = call.name as ToolName;
    const parsed = inputs[name].safeParse(call.input);
    if (!parsed.success) {
      return this.err(call, `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
    }
    const input = parsed.data as any;
    try {
      switch (name) {
        case 'read_file':
          return this.ok(call, await this.readFile(input));
        case 'list_dir':
          return this.ok(call, await this.listDir(input));
        case 'search':
          return this.ok(call, await this.search(input));
        case 'write_file': {
          const { rel, abs } = this.policy.checkWrite(input.path, name);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, input.content, 'utf8');
          return { ...this.ok(call, `Wrote ${rel} (${input.content.length} chars)`), wrote: rel };
        }
        case 'edit_file':
          return await this.editFile(call, input);
        case 'run_command':
          return this.ok(call, await this.runCommand(input));
        case 'finish':
          return {
            result: { toolCallId: call.id, content: 'Finish received. Gates are now evaluating your work.' },
            finished: { summary: input.summary },
          };
      }
    } catch (e) {
      if (e instanceof PolicyViolationError) throw e;
      return this.err(call, (e as Error).message);
    }
  }

  private ok(call: ToolCall, content: string): ToolOutcome {
    return { result: { toolCallId: call.id, content } };
  }

  private err(call: ToolCall, content: string): ToolOutcome {
    return { result: { toolCallId: call.id, content, isError: true } };
  }

  private async readFile(input: { path: string; offset?: number; limit?: number }): Promise<string> {
    const { rel, abs } = this.policy.checkRead(input.path, 'read_file');
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new Error(`File not found: ${rel}`);
    if (stat.isDirectory()) throw new Error(`${rel} is a directory; use list_dir`);
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${rel} is a binary file`);
    const lines = buf.toString('utf8').split('\n');
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? 2000));
    let out = '';
    for (let i = start; i < end; i++) {
      const line = `${i + 1}\t${lines[i]}\n`;
      if (out.length + line.length > MAX_READ_CHARS) {
        out += `... [output capped; continue with offset=${i + 1}]\n`;
        break;
      }
      out += line;
    }
    if (end < lines.length && !out.includes('[output capped')) out += `... [${lines.length - end} more lines; continue with offset=${end + 1}]\n`;
    return out || '(empty file)';
  }

  private async listDir(input: { path: string; depth: number }): Promise<string> {
    const { rel, abs } = this.policy.checkRead(input.path, 'list_dir');
    const out: string[] = [];
    const walk = async (dirAbs: string, dirRel: string, depth: number) => {
      const entries = await fs.readdir(dirAbs, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= 1000) return;
        const childRel = dirRel === '.' ? e.name : `${dirRel}/${e.name}`;
        if (this.policy.hidden(childRel) || this.policy.hidden(`${childRel}/`)) continue;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) {
            out.push(`${childRel}/ (skipped)`);
            continue;
          }
          out.push(`${childRel}/`);
          if (depth > 1) await walk(path.join(dirAbs, e.name), childRel, depth - 1);
        } else {
          out.push(childRel);
        }
      }
    };
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${rel}`);
    await walk(abs, rel, input.depth);
    if (out.length >= 1000) out.push('... [listing capped at 1000 entries; narrow the path]');
    return out.join('\n') || '(empty directory)';
  }

  private async search(input: { pattern: string; path: string; glob?: string; ignore_case?: boolean }): Promise<string> {
    const { rel } = this.policy.checkRead(input.path, 'search');
    const args = ['grep', '--untracked', '-n', '-I', '-E', ...(input.ignore_case ? ['-i'] : []), '-e', input.pattern, '--'];
    args.push(input.glob ? `:(glob)${rel === '.' ? '' : `${rel}/`}${input.glob}` : rel);
    const res = await runProcess('git', args, { cwd: this.root, timeoutMs: 60_000, env: safeEnv(), maxOutputBytes: 1024 * 1024 });
    if (res.code === 1) return 'No matches.';
    if (res.code !== 0) throw new Error(`search failed: ${res.output.slice(0, 500)}`);
    const lines = res.output
      .split('\n')
      .filter(Boolean)
      .filter((l) => !this.policy.hidden(l.slice(0, l.indexOf(':'))));
    const shown = lines.slice(0, 200).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
    if (lines.length > 200) shown.push(`... [${lines.length - 200} more matches; refine the pattern]`);
    return shown.join('\n') || 'No matches.';
  }

  private async editFile(
    call: ToolCall,
    input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ): Promise<ToolOutcome> {
    const { rel, abs } = this.policy.checkWrite(input.path, 'edit_file');
    const content = await fs.readFile(abs, 'utf8').catch(() => null);
    if (content === null) return this.err(call, `File not found: ${rel}. Use write_file to create files.`);
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return this.err(call, `old_string not found in ${rel}. Read the file and copy the exact text.`);
    if (count > 1 && !input.replace_all) {
      return this.err(call, `old_string occurs ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all.`);
    }
    const next = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, () => input.new_string);
    await fs.writeFile(abs, next, 'utf8');
    return { ...this.ok(call, `Edited ${rel} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? 's' : ''})`), wrote: rel };
  }

  private async runCommand(input: { command: string; timeout_seconds?: number }): Promise<string> {
    this.policy.checkCommand(input.command);
    const limit = this.policy.policy.commandTimeoutSeconds;
    const timeout = Math.min(input.timeout_seconds ?? limit, limit);
    const before = await this.workingTreeSnapshot();
    const res = await runShell(input.command, {
      cwd: this.root,
      timeoutMs: timeout * 1000,
      env: safeEnv(),
      maxOutputBytes: 30 * 1024,
      signal: this.signal,
    });
    // The shell must not become a way around the write policy.
    const after = await this.workingTreeSnapshot();
    const touched = new Set<string>();
    for (const [p, sig] of after) if (before.get(p) !== sig) touched.add(p);
    for (const p of before.keys()) if (!after.has(p)) touched.add(p);
    for (const p of touched) {
      try {
        this.policy.checkWrite(p, 'run_command');
      } catch (e) {
        if (e instanceof PolicyViolationError) {
          throw new PolicyViolationError(e.rule, `Command modified "${p}": ${e.detail}`, 'run_command', input.command);
        }
        throw e;
      }
    }
    return `exit code: ${res.code}${res.timedOut ? ' (timed out)' : ''}\n${res.output || '(no output)'}`;
  }

  /** Changed/untracked (non-ignored) files with a size+mtime signature. */
  private async workingTreeSnapshot(): Promise<Map<string, string>> {
    const res = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: this.root,
      timeoutMs: 60_000,
      env: safeEnv(),
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const map = new Map<string, string>();
    if (res.code !== 0) return map;
    const parts = res.output.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      if (status[0] === 'R' || status[0] === 'C') i++; // skip the rename source
      const st = await fs.stat(path.join(this.root, file)).catch(() => null);
      map.set(file, st ? `${st.size}:${st.mtimeMs}` : 'deleted');
    }
    return map;
  }
}
