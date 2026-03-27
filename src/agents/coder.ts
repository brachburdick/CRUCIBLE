import type {
  AgentFn,
  LlmMessage,
  TaskPayload,
  ToolDefinition,
  ToolCall,
  ContentBlock,
} from '../types/index.js';

const DEFAULT_MAX_TURNS = 50;

/** Configuration for the coder agent — the variant-specific parameterization point */
export interface CoderAgentConfig {
  /** Full system prompt (assembled from variant config + skills) */
  systemPrompt: string;
  /** Model override (passed through LlmCallOptions) */
  model?: string;
  /** Maximum agentic loop turns before forced stop */
  maxTurns?: number;
}

/** Default system prompt when no variant config is provided */
const DEFAULT_SYSTEM_PROMPT = [
  'You are a coding agent running inside an isolated sandbox environment.',
  'You have access to tools for reading files, writing files, and executing shell commands.',
  'Use these tools to complete the task described by the user.',
  'When the task is fully complete, call the task_complete tool.',
  'Be methodical: read relevant files first, understand the codebase, then make changes.',
  'After making changes, verify them by running tests or checking output.',
].join('\n');

/** Tool definitions exposed to Claude */
const CODER_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (relative to /home/user or absolute)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file at the given path. Creates the file if it does not exist, overwrites if it does.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write (relative to /home/user or absolute)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'exec',
    description: 'Execute a shell command in the sandbox. Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'task_complete',
    description: 'Signal that the task is fully complete. Call this when all work is done and verified.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was accomplished' },
      },
      required: ['summary'],
    },
  },
];

/**
 * Execute a single tool call against the sandbox ToolContext.
 * Returns a string result (or error message).
 */
async function executeTool(
  toolCall: ToolCall,
  tools: { exec: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>; writeFile: (path: string, content: string) => Promise<void>; readFile: (path: string) => Promise<string> },
): Promise<{ content: string; isError: boolean }> {
  try {
    switch (toolCall.name) {
      case 'read_file': {
        const filePath = toolCall.input['path'] as string;
        const content = await tools.readFile(filePath);
        return { content, isError: false };
      }
      case 'write_file': {
        const filePath = toolCall.input['path'] as string;
        const fileContent = toolCall.input['content'] as string;
        await tools.writeFile(filePath, fileContent);
        return { content: `File written: ${filePath}`, isError: false };
      }
      case 'exec': {
        const command = toolCall.input['command'] as string;
        const result = await tools.exec(command);
        const parts = [`exit_code: ${result.exitCode}`];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        return { content: parts.join('\n'), isError: false };
      }
      case 'task_complete': {
        const summary = toolCall.input['summary'] as string;
        return { content: `Task complete: ${summary}`, isError: false };
      }
      default:
        return { content: `Unknown tool: ${toolCall.name}`, isError: true };
    }
  } catch (err) {
    return {
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

/**
 * Factory that creates a coder agent bound to a task payload and configuration.
 *
 * The coder agent uses Claude's native tool_use API with structured tools
 * (read_file, write_file, exec, task_complete) instead of text-parsed markers.
 *
 * The system prompt is the variant-specific parameterization point — different
 * variants produce different agent behaviors by changing the instructions.
 */
export function createCoderAgent(task: TaskPayload, config?: CoderAgentConfig): AgentFn {
  const systemPrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTurns = config?.maxTurns ?? DEFAULT_MAX_TURNS;
  const model = config?.model;

  return async (llmCall, tools) => {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Task: ${task.description}\n\nInstructions:\n${task.instructions}`,
      },
    ];

    const writtenFiles: string[] = [];

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await llmCall(messages, {
        tools: CODER_TOOLS,
        model,
      });

      // If the model returned text only (no tool calls), add it and check if done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: response.content });

        // If stop reason is end_turn with no tools, the model is done talking
        if (response.stopReason === 'end_turn') {
          return {
            finalMessage: response.content,
            artifacts: writtenFiles.length > 0 ? writtenFiles : undefined,
          };
        }

        // Prompt to continue
        messages.push({ role: 'user', content: 'Continue with the task. Use the available tools.' });
        continue;
      }

      // Build the assistant message with both text and tool_use blocks
      const assistantBlocks: ContentBlock[] = [];
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content });
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: 'assistant', content: assistantBlocks });

      // Execute each tool call and collect results
      const toolResultBlocks: ContentBlock[] = [];
      let taskCompleted = false;
      let completionSummary = '';

      for (const tc of response.toolCalls) {
        if (tc.name === 'task_complete') {
          taskCompleted = true;
          completionSummary = (tc.input['summary'] as string) ?? 'Task completed';
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Task complete: ${completionSummary}`,
          });
          continue;
        }

        const result = await executeTool(tc, tools);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: result.content,
          is_error: result.isError || undefined,
        });

        if (tc.name === 'write_file') {
          writtenFiles.push(tc.input['path'] as string);
        }
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResultBlocks });

      if (taskCompleted) {
        return {
          finalMessage: completionSummary,
          artifacts: writtenFiles.length > 0 ? writtenFiles : undefined,
        };
      }
    }

    // Turn limit reached
    return {
      finalMessage: `Turn limit (${maxTurns}) reached without task completion`,
      artifacts: writtenFiles.length > 0 ? writtenFiles : undefined,
    };
  };
}
