import type { LlmCallFn, LlmMessage, LlmCallOptions, LlmResponse, ToolCall } from '../types/index.js';

/**
 * Base LLM call via the Anthropic Messages API.
 * Reads ANTHROPIC_API_KEY from the environment.
 *
 * Supports both text-only and tool_use modes:
 * - Without tools: returns content as text (backward compatible)
 * - With tools: returns content + toolCalls array + stopReason
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

  // Build message array — handle both string content and structured content blocks
  const apiMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  // Extract system message — must be string
  const systemMsg = messages.find((m) => m.role === 'system');
  const systemText = systemMsg
    ? (typeof systemMsg.content === 'string' ? systemMsg.content : '')
    : undefined;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: apiMessages,
  };

  if (systemText) {
    body['system'] = systemText;
  }

  if (options?.temperature !== undefined) {
    body['temperature'] = options.temperature;
  }

  // Add tool definitions if provided
  if (options?.tools && options.tools.length > 0) {
    body['tools'] = options.tools;
  }

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
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
  };

  // Extract text content
  const content = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  // Extract tool calls
  const toolCalls: ToolCall[] = data.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id!,
      name: block.name!,
      input: block.input!,
    }));

  return {
    content,
    usage: {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    },
    model: data.model,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: data.stop_reason,
  };
};
