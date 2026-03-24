import type { AgentFn, LlmMessage, TaskPayload } from '../types/index.js';

/**
 * Creates a looping agent that sends the same message to the LLM every turn,
 * guaranteeing repetitive responses that trigger the loop detector.
 *
 * Used for integration testing the semantic loop detection middleware.
 */
export function createLoopingAgent(task: TaskPayload): AgentFn {
  return async (llmCall, _tools) => {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: 'You are a diagnostic agent. Answer the question concisely.',
      },
    ];

    let lastResponse = '';

    // Send the same question repeatedly until middleware kills us
    for (let turn = 0; turn < 100; turn++) {
      messages.push({
        role: 'user',
        content: task.instructions,
      });

      const response = await llmCall(messages);
      lastResponse = response.content;
      messages.push({ role: 'assistant', content: response.content });
    }

    return { finalMessage: lastResponse };
  };
}
