import { OpenAICompatibleProvider, stripKeywords } from './openaiCompatible';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Google Gemini through its OpenAI-compatible endpoint. Works with a free Google AI Studio key
 * (Flash / Flash-Lite models); free-tier traffic may be used by Google to improve its products.
 */
export class GeminiProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: 'gemini',
      label: 'Google Gemini',
      configHint:
        'Set GEMINI_API_KEY (create one free at Google AI Studio). Free-tier prompts may be used by Google to improve its products — use test or personal repos only.',
      apiKey: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      baseURL: () => process.env.GEMINI_BASE_URL || GEMINI_OPENAI_BASE_URL,
      isConfigured: () => !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      tokenParam: () => 'max_tokens',
      maxOutputTokens: 32_768,
      reasoningEffort: (e) => (e === 'low' ? 'low' : e === 'medium' ? 'medium' : 'high'),
      // Gemini function declarations use an OpenAPI subset; it has rejected these keywords.
      sanitizeSchema: (s) => stripKeywords(s, ['additionalProperties', '$schema']),
      modelIdPrefix: 'models/',
    });
  }
}
