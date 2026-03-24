import type { LlmCallFn, LlmMessage, LlmCallOptions, LlmResponse } from '../types/index.js';

/**
 * Base LLM call via the Anthropic Messages API.
 * Reads ANTHROPIC_API_KEY from the environment.
 */
export const baseLlmCall: LlmCallFn = async (
  messages: LlmMessage[],
  options?: LlmCallOptions,
): Promise<LlmResponse> => {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const model = options?.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = options?.maxTokens ?? 4096;

  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
    ...(messages.some((m) => m.role === 'system')
      ? { system: messages.find((m) => m.role === 'system')!.content }
      : {}),
    ...(options?.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  const content = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  return {
    content,
    usage: {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    },
    model: data.model,
  };
};
