import type { AgentFn, LlmMessage } from '../types/index.js';

const MAX_TURNS = 50;
const DONE_MARKER = 'TASK_COMPLETE';

/**
 * Echo agent — agentic loop that sends task instructions to the LLM,
 * follows the LLM's lead on tool use, and terminates when the LLM
 * signals completion or the turn limit is reached.
 *
 * The same agent works for simple tasks (completes in 1–3 turns) and
 * looping tasks (the task instructions cause the LLM to repeat itself,
 * triggering the loop detector middleware).
 */
export const agent: AgentFn = async (llmCall, tools) => {
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: [
        'You are a task-completion agent running inside a sandbox.',
        'You have access to a filesystem. The human will relay tool results back to you.',
        'When you want to write a file, output a line: WRITE_FILE:<path>:<content>',
        'When you want to run a shell command, output a line: EXEC:<command>',
        `When the task is fully done, include the marker "${DONE_MARKER}" in your response.`,
        'Be concise. Complete the task as described.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Here is your task. Follow the instructions exactly.',
    },
  ];

  let lastResponse = '';
  const writtenFiles: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await llmCall(messages);
    lastResponse = response.content;

    // Append assistant response to conversation
    messages.push({ role: 'assistant', content: response.content });

    // Parse and execute tool actions from the response
    const toolResults: string[] = [];

    for (const line of response.content.split('\n')) {
      const writeMatch = line.match(/^WRITE_FILE:([^:]+):(.+)$/);
      if (writeMatch) {
        const filePath = writeMatch[1]!;
        const content = writeMatch[2]!;
        await tools.writeFile(filePath, content);
        writtenFiles.push(filePath);
        toolResults.push(`Wrote file: ${filePath}`);
      }

      const execMatch = line.match(/^EXEC:(.+)$/);
      if (execMatch) {
        const cmd = execMatch[1]!;
        const result = await tools.exec(cmd);
        toolResults.push(
          `Exec [exit=${result.exitCode}]: ${result.stdout}${result.stderr ? `\nstderr: ${result.stderr}` : ''}`,
        );
      }
    }

    // Check for completion marker
    if (response.content.includes(DONE_MARKER)) {
      return {
        finalMessage: lastResponse,
        artifacts: writtenFiles.length > 0 ? writtenFiles : undefined,
      };
    }

    // Feed tool results back (or prompt to continue)
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults.join('\n') });
    } else {
      messages.push({ role: 'user', content: 'Continue with the task.' });
    }
  }

  // Turn limit reached without explicit completion
  return {
    finalMessage: lastResponse,
    artifacts: writtenFiles.length > 0 ? writtenFiles : undefined,
  };
};
