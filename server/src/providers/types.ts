import type { ArtifactContract, Effort } from '@harness/shared';

/** Provider-neutral tool definition. The harness owns every tool, so gates apply to all providers equally. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * Provider-neutral transcript. Assistant turns keep the provider's raw content so
 * the same provider gets it back verbatim (thinking blocks etc. must round-trip unchanged).
 * The transcript is append-only.
 */
export type ConversationItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: { provider: string; data: unknown } }
  | { role: 'tool'; results: ToolResult[] };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ConversationItem[];
  tools: ToolSpec[];
  effort: Effort;
  signal?: AbortSignal;
  /** Stage hints. Real providers ignore them; the offline mock agent uses them to produce valid artifacts. */
  meta?: {
    operationKey: string;
    artifacts: (ArtifactContract & { repoPath: string })[];
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  stopDetail?: string;
  usage: TokenUsage;
  /** Model that actually served the request (may differ after a server-side fallback). */
  model: string;
  raw?: { provider: string; data: unknown };
}

export interface AgentProvider {
  id: string;
  label: string;
  /** How to configure this provider, shown in Settings. */
  configHint: string;
  isConfigured(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
