import { AnthropicProvider } from './anthropic';
import { MockProvider } from './mock';
import { OpenAIProvider } from './openai';
import type { AgentProvider } from './types';

/**
 * Pluggable provider registry. To add a provider, implement `AgentProvider`
 * (one `complete()` call per turn) and register it here: tools, policy and gates
 * are owned by the harness and work unchanged.
 */
export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  constructor(list: AgentProvider[] = [new AnthropicProvider(), new OpenAIProvider(), new MockProvider()]) {
    for (const p of list) this.register(p);
  }

  register(p: AgentProvider) {
    this.providers.set(p.id, p);
  }

  get(id: string): AgentProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Unknown provider "${id}". Known: ${[...this.providers.keys()].join(', ')}`);
    return p;
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }
}
