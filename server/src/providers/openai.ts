import { OpenAICompatibleProvider } from './openaiCompatible';

/**
 * OpenAI Chat Completions. Set OPENAI_BASE_URL to point it at any other OpenAI-compatible
 * server (Ollama, vLLM, LM Studio, gateways) instead.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: 'openai',
      label: 'OpenAI / OpenAI-compatible',
      configHint: 'Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL for an OpenAI-compatible endpoint.',
      apiKey: () => process.env.OPENAI_API_KEY,
      baseURL: () => process.env.OPENAI_BASE_URL,
      isConfigured: () => !!(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
      // api.openai.com wants max_completion_tokens; most compatible servers only know max_tokens.
      tokenParam: () => (process.env.OPENAI_BASE_URL ? 'max_tokens' : 'max_completion_tokens'),
      maxOutputTokens: 16_384,
    });
  }
}
