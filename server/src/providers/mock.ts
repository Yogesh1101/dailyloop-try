import type { ArtifactContract } from '@harness/shared';
import type { AgentProvider, CompletionRequest, CompletionResponse, ConversationItem, ToolCall } from './types';

/**
 * Offline agent for demos and tests. It behaves like a well-mannered agent:
 * look around, write every required artifact so it satisfies its contract, then finish.
 * It never touches code, so it exercises the harness (policy, gates, approvals) without an API key.
 */
export class MockProvider implements AgentProvider {
  id = 'mock';
  label = 'Mock agent (offline)';
  configHint = 'Always available. Produces contract-valid placeholder artifacts; useful to try pipelines and gates.';
  private seq = 0;

  isConfigured(): boolean {
    return true;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const tools = new Set(req.tools.map((t) => t.name));
    const lastAssistant = [...req.messages].reverse().find((m) => m.role === 'assistant') as
      | Extract<ConversationItem, { role: 'assistant' }>
      | undefined;
    const lastNames = lastAssistant?.toolCalls.map((t) => t.name) ?? [];
    const artifacts = req.meta?.artifacts ?? [];
    const feedback = [...req.messages].reverse().find((m) => m.role === 'user') as
      | Extract<ConversationItem, { role: 'user' }>
      | undefined;

    let calls: ToolCall[];
    let text: string;
    if (!lastAssistant) {
      calls = [this.call('list_dir', { path: '.', depth: 1 })];
      text = 'Inspecting the repository layout before producing artifacts.';
    } else if ((lastNames.includes('list_dir') || lastNames.includes('finish')) && tools.has('write_file') && artifacts.length) {
      calls = artifacts.map((a) =>
        this.call('write_file', { path: a.repoPath, content: renderArtifact(a, req.meta!.operationKey, feedback?.text ?? '') }),
      );
      text = lastNames.includes('finish')
        ? 'Gate feedback received; rewriting artifacts to satisfy the contracts.'
        : 'Writing the required artifacts.';
    } else {
      calls = [
        this.call('finish', {
          summary: `Mock agent completed "${req.meta?.operationKey ?? 'stage'}" and wrote ${artifacts.length} artifact(s). No code was changed.`,
        }),
      ];
      text = 'All artifacts written.';
    }

    const inputChars = req.system.length + JSON.stringify(req.messages).length;
    const outputChars = text.length + JSON.stringify(calls).length;
    return {
      text,
      toolCalls: calls,
      stopReason: 'tool_use',
      usage: {
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: Math.ceil(outputChars / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: req.model,
    };
  }

  private call(name: string, input: unknown): ToolCall {
    this.seq += 1;
    return { id: `mock_${Date.now().toString(36)}_${this.seq}`, name, input };
  }
}

const SENTENCE =
  'This section was produced by the offline mock agent so that the harness pipeline, gates and approvals can be exercised end to end without a model provider.';

function sectionBody(heading: string, op: string): string {
  const h = heading.toLowerCase();
  if (h === 'pr title') return `chore(mock): offline ${op} run`;
  if (h.includes('requirement') && !h.includes('non-functional')) {
    return 'REQ-1: The system MUST produce every artifact required by the active operation.\nREQ-2: The system MUST NOT modify files outside the approved plan.';
  }
  if (h.includes('acceptance')) {
    return '- AC-1 (REQ-1): Given a configured pipeline When the mock agent runs Then every artifact contract passes.\n- AC-2 (REQ-2): Given an approved plan When the implementation stage ends Then the diff stays within the plan.';
  }
  if (h.includes('open question')) return 'Q1: None. The mock agent has no open questions.';
  return SENTENCE;
}

function renderArtifact(a: ArtifactContract, op: string, feedback: string): string {
  if (a.format === 'json') {
    return JSON.stringify(a.jsonSchema ? fromSchema(a.jsonSchema, '') : { mock: true }, null, 2);
  }
  const parts = [`# ${a.id} (${op})`, '', `_Offline mock output. Feedback considered: ${feedback ? 'yes' : 'none'}._`, ''];
  for (const h of a.requiredHeadings) parts.push(`## ${h}`, '', sectionBody(h, op), '');
  parts.push('## Notes', '', 'Task T1 covers AC-1 (REQ-1). Given the mock harness When it runs Then all gates are exercised.', '');
  let out = parts.join('\n');
  while (out.length < a.minChars) out += `\n${SENTENCE}\n`;
  return out;
}

/** Minimal JSON Schema instance generator: enough for artifact contracts. */
function fromSchema(schema: Record<string, any>, key: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Record<string, any>>;
      for (const name of (schema.required as string[] | undefined) ?? Object.keys(props)) {
        out[name] = fromSchema(props[name] ?? {}, name);
      }
      return out;
    }
    case 'array': {
      if (key === 'findings') return [];
      const n = Math.max(schema.minItems ?? 0, 1);
      return Array.from({ length: n }, (_, i) => fromSchema(schema.items ?? {}, `${key}${i}`));
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'string':
    default: {
      if (/^(id|tasks\d+)$/.test(key) || key.startsWith('id')) return 'T1';
      if (key.startsWith('files')) return '.harness/README.md';
      if (key.startsWith('acceptanceCriteria')) return 'AC-1';
      const s = `mock ${key || 'value'}`;
      return s.length >= (schema.minLength ?? 0) ? s : s.padEnd(schema.minLength, '.');
    }
  }
}
