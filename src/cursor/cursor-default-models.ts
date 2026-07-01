/**
 * Cursor Default Model Catalog
 */

import type { CursorModel } from './types';

/** Default model ID */
export const DEFAULT_CURSOR_MODEL = 'gpt-5.3-codex';

/**
 * Default models available through Cursor IDE.
 * Used as fallback when daemon is not reachable.
 * Source: Cursor docs / official announcements (Apr 2026)
 */
export const DEFAULT_CURSOR_MODELS: CursorModel[] = [
  // Anthropic Models
  {
    id: 'claude-4.7-opus',
    name: 'Claude 4.7 Opus',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.7-opus-fast-mode',
    name: 'Claude 4.7 Opus (Fast mode)',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.6-opus',
    name: 'Claude 4.6 Opus',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.6-opus-fast-mode',
    name: 'Claude 4.6 Opus (Fast mode)',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.5-sonnet',
    name: 'Claude 4.5 Sonnet',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.5-opus',
    name: 'Claude 4.5 Opus',
    provider: 'anthropic',
  },
  {
    id: 'claude-4.5-haiku',
    name: 'Claude 4.5 Haiku',
    provider: 'anthropic',
  },
  {
    id: 'claude-4-sonnet',
    name: 'Claude 4 Sonnet',
    provider: 'anthropic',
  },
  {
    id: 'claude-4-sonnet-1m',
    name: 'Claude 4 Sonnet 1M',
    provider: 'anthropic',
  },

  // Cursor Models
  {
    id: 'composer-2.5',
    name: 'Composer 2.5',
    provider: 'cursor',
  },
  {
    id: 'composer-2.5-fast',
    name: 'Composer 2.5 Fast',
    provider: 'cursor',
  },
  {
    id: 'composer-1.5',
    name: 'Composer 1.5',
    provider: 'cursor',
  },
  {
    id: 'composer-1',
    name: 'Composer 1',
    provider: 'cursor',
  },

  // OpenAI Models
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'openai',
    isDefault: true,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    provider: 'openai',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    provider: 'openai',
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    provider: 'openai',
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    provider: 'openai',
  },
  {
    id: 'gpt-5-codex',
    name: 'GPT-5-Codex',
    provider: 'openai',
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
  },
  {
    id: 'gpt-5-fast',
    name: 'GPT-5 Fast',
    provider: 'openai',
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
  },

  // Google Models
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'google',
  },
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Gemini 3 Pro Image Preview',
    provider: 'google',
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'google',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
  },

  // xAI Models
  {
    id: 'grok-code',
    name: 'Grok Code',
    provider: 'xai',
  },
];

/**
 * Detect provider from model ID.
 */
export function detectProvider(modelId: string): string {
  if (modelId.includes('claude')) return 'anthropic';
  if (modelId.includes('gpt') || /^o[1-9]\d*(-|$)/.test(modelId)) return 'openai';
  if (modelId.includes('gemini')) return 'google';
  if (modelId.includes('cursor') || modelId.includes('composer')) return 'cursor';
  if (modelId.includes('grok')) return 'xai';
  return 'unknown';
}

/**
 * Format model ID to human-readable name.
 */
export function formatModelName(modelId: string): string {
  const model = DEFAULT_CURSOR_MODELS.find((m) => m.id === modelId);
  if (model) {
    return model.name;
  }

  return modelId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
