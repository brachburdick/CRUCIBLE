import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentOutput,
  OnTurnCallback,
  ToolContext,
  TaskPayload,
} from '../types/index.js';

// ─── Stream-JSON event types from `claude -p --output-format stream-json` ───

/** Top-level discriminated union for CLI stream-json lines */
export type CliStreamEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliResultEvent
  | CliStreamDelta
  | CliRateLimitEvent;

export interface CliSystemEvent {
  type: 'system';
  subtype: 'init' | 'api_retry';
  session_id?: string;
  tools?: string[];
  model?: string;
  [key: string]: unknown;
}

export interface CliAssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    content: Array<CliContentBlock>;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  session_id: string;
}

export type CliContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface CliResultEvent {
  type: 'result';
  subtype: 'success' | 'error' | 'stopped';
  is_error: boolean;
  result: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface CliStreamDelta {
  type: 'stream_event';
  event: {
    type: string;
    delta?: { type: string; text?: string };
    [key: string]: unknown;
  };
  session_id: string;
}

export interface CliRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
  };
}

// ─── Configuration ───

export interface CliRunnerConfig {
  /** Task description and instructions */
  task: TaskPayload;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Model alias or full name (e.g. 'sonnet', 'opus', 'claude-sonnet-4-6') */
  model?: string;
  /** Max agentic turns */
  maxTurns?: number;
  /** Max spend in USD (uses Claude Max subscription, so this is advisory) */
  maxBudgetUsd?: number;
  /** Working directory for the claude process */
  cwd?: string;
  /** Permission mode ('bypassPermissions' recommended for automated use) */
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'auto';
  /** Allowed tools (e.g. ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) */
  allowedTools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];
  /** Per-turn event callback — maps CLI events to CRUCIBLE events */
  onTurn?: OnTurnCallback;
  /** Wall-clock TTL in ms. The CLI process is killed after this. */
  ttlMs?: number;
  /** Additional CLI flags */
  extraFlags?: string[];
  /** Path to the claude binary (default: 'claude') */
  claudeBinary?: string;
}

// ─── CLI Runner ───

/**
 * Spawns `claude -p` as a child process, parses stream-json output,
 * and maps events to CRUCIBLE's AgentTurnEvent callbacks.
 *
 * Uses the Claude Code subscription (Max plan) for billing instead of
 * ANTHROPIC_API_KEY. The key advantage: no per-token API costs.
 *
 * The agent runs on the HOST filesystem (no E2B sandbox). Isolation
 * comes from:
 *   1. --cwd pointed at a temp directory with seeded files
 *   2. --allowedTools restricting what the agent can do
 *   3. --permission-mode bypassPermissions (no interactive prompts)
 *   4. --bare (skips hooks, skills, CLAUDE.md, MCP servers)
 *
 * If you need E2B-level isolation, wrap this in a Docker container.
 */
export async function runClaudeCliAgent(config: CliRunnerConfig): Promise<CliAgentResult> {
  const claudeBin = config.claudeBinary ?? 'claude';

  // Build the prompt from task payload
  const prompt = `Task: ${config.task.description}\n\nInstructions:\n${config.task.instructions}`;

  // Assemble CLI flags
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',      // Don't persist sessions to disk
  ];

  if (config.systemPrompt) {
    args.push('--system-prompt', config.systemPrompt);
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.maxTurns) {
    args.push('--max-turns', String(config.maxTurns));
  }

  if (config.maxBudgetUsd) {
    args.push('--max-budget-usd', String(config.maxBudgetUsd));
  }

  if (config.permissionMode) {
    args.push('--permission-mode', config.permissionMode);
  }

  if (config.allowedTools && config.allowedTools.length > 0) {
    for (const tool of config.allowedTools) {
      args.push('--allowedTools', tool);
    }
  }

  if (config.disallowedTools && config.disallowedTools.length > 0) {
    for (const tool of config.disallowedTools) {
      args.push('--disallowedTools', tool);
    }
  }

  if (config.extraFlags) {
    args.push(...config.extraFlags);
  }

  // Spawn the process — prompt will be piped via stdin
  const proc = spawn(claudeBin, args, {
    cwd: config.cwd ?? process.cwd(),
    env: {
      ...process.env,
      // Don't pass ANTHROPIC_API_KEY — we want subscription auth
      ANTHROPIC_API_KEY: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write prompt via stdin, then close (claude -p reads from stdin)
  proc.stdin?.write(prompt);
  proc.stdin?.end();

  // Set up TTL kill
  let ttlTimer: NodeJS.Timeout | null = null;
  let killedByTtl = false;

  if (config.ttlMs) {
    ttlTimer = setTimeout(() => {
      killedByTtl = true;
      proc.kill('SIGTERM');
      // Give it 5s to clean up, then SIGKILL
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, config.ttlMs);
    ttlTimer.unref();
  }

  // Parse stream-json output
  const result = await parseCliStream(proc, config.onTurn);

  if (ttlTimer) clearTimeout(ttlTimer);

  if (killedByTtl) {
    result.killReason = 'ttl_exceeded';
  }

  return result;
}

// ─── Stream parser ───

export interface CliAgentResult {
  /** Final text output from the agent */
  finalMessage: string;
  /** Why the run ended */
  killReason: 'completed' | 'error' | 'stopped' | 'ttl_exceeded' | 'rate_limited';
  /** Session ID from the CLI (can be used for --resume) */
  sessionId: string | null;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Token usage */
  usage: { inputTokens: number; outputTokens: number };
  /** Number of agentic turns */
  numTurns: number;
  /** Wall time in ms */
  durationMs: number;
  /** Files the agent wrote (extracted from tool_use events) */
  writtenFiles: string[];
  /** stderr output (for debugging) */
  stderr: string;
}

export async function parseCliStream(
  proc: ChildProcess,
  onTurn?: OnTurnCallback,
): Promise<CliAgentResult> {
  const result: CliAgentResult = {
    finalMessage: '',
    killReason: 'completed',
    sessionId: null,
    totalCostUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    numTurns: 0,
    durationMs: 0,
    writtenFiles: [],
    stderr: '',
  };

  let turn = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;

  // Collect stderr
  const stderrChunks: string[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

  // Parse stdout line by line (NDJSON)
  const rl = createInterface({ input: proc.stdout! });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let event: CliStreamEvent;
    try {
      event = JSON.parse(line) as CliStreamEvent;
    } catch {
      // Non-JSON line — skip
      continue;
    }

    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init') {
          result.sessionId = event.session_id ?? null;
        }
        break;
      }

      case 'assistant': {
        const msg = event.message;
        cumulativeInputTokens += msg.usage.input_tokens;
        cumulativeOutputTokens += msg.usage.output_tokens;

        // Extract text content for thinking event
        const textBlocks = msg.content.filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
        const textContent = textBlocks.map(b => b.text).join('');

        if (textContent && onTurn) {
          onTurn({
            type: 'agent_thinking',
            turn,
            content: textContent.length > 2000 ? textContent.slice(0, 2000) + '…' : textContent,
            usage: {
              promptTokens: msg.usage.input_tokens,
              completionTokens: msg.usage.output_tokens,
            },
          });
        }

        // Extract tool_use blocks
        const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use') as Array<{
          type: 'tool_use'; id: string; name: string; input: Record<string, unknown>;
        }>;

        for (const tc of toolUseBlocks) {
          if (onTurn) {
            onTurn({
              type: 'agent_tool_call',
              turn,
              toolCallId: tc.id,
              toolName: tc.name,
              toolInput: tc.name === 'Write'
                ? { file_path: tc.input['file_path'] }  // Don't send full file content
                : tc.input,
            });
          }

          // Track written files
          if (tc.name === 'Write' || tc.name === 'Edit') {
            const filePath = (tc.input['file_path'] as string) ?? '';
            if (filePath) result.writtenFiles.push(filePath);
          }
        }

        // Extract tool_result blocks (in the same assistant message, if batched)
        const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result') as Array<{
          type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean;
        }>;

        for (const tr of toolResultBlocks) {
          if (onTurn) {
            onTurn({
              type: 'agent_tool_result',
              turn,
              toolCallId: tr.tool_use_id,
              toolName: 'unknown',  // CLI doesn't repeat tool name in results
              content: tr.content.length > 2000 ? tr.content.slice(0, 2000) + '…' : tr.content,
              isError: tr.is_error ?? false,
            });
          }
        }

        // Emit turn complete
        if (onTurn) {
          onTurn({
            type: 'agent_turn_complete',
            turn,
            cumulativeTokens: cumulativeInputTokens + cumulativeOutputTokens,
          });
        }

        turn++;
        break;
      }

      case 'result': {
        result.finalMessage = event.result ?? '';
        result.totalCostUsd = event.total_cost_usd ?? 0;
        result.numTurns = event.num_turns ?? turn;
        result.durationMs = event.duration_ms ?? 0;
        result.sessionId = event.session_id ?? result.sessionId;

        if (event.usage) {
          result.usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        } else {
          result.usage = {
            inputTokens: cumulativeInputTokens,
            outputTokens: cumulativeOutputTokens,
          };
        }

        if (event.subtype === 'error') {
          result.killReason = 'error';
        } else if (event.subtype === 'stopped') {
          result.killReason = 'stopped';
        } else {
          result.killReason = 'completed';
        }
        break;
      }

      case 'rate_limit_event': {
        if (event.rate_limit_info.status !== 'allowed') {
          result.killReason = 'rate_limited';
        }
        break;
      }

      // stream_event — we don't need deltas for CRUCIBLE, we get full messages via 'assistant'
      default:
        break;
    }
  }

  // Wait for process to exit
  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on('close', (code) => resolve(code));
  });

  result.stderr = stderrChunks.join('');

  if (exitCode !== 0 && result.killReason === 'completed') {
    result.killReason = 'error';
  }

  return result;
}

// ─── AgentFn adapter ───

/**
 * Creates an AgentFn-compatible wrapper around the CLI runner.
 * This allows the CLI agent to slot into CRUCIBLE's existing agent registry.
 *
 * Note: The `llmCall` and `tools` (ToolContext) parameters are IGNORED —
 * the CLI handles its own LLM calls and tool execution. They're accepted
 * only to satisfy the AgentFn signature.
 */
export interface CliAgentConfig {
  systemPrompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  permissionMode?: CliRunnerConfig['permissionMode'];
  allowedTools?: string[];
  disallowedTools?: string[];
  onTurn?: OnTurnCallback;
  ttlMs?: number;
  claudeBinary?: string;
  extraFlags?: string[];
}

export function createCliAgent(task: TaskPayload, config?: CliAgentConfig) {
  const effectiveConfig = config ?? { systemPrompt: '' };

  // Return an AgentFn — llmCall and tools are ignored since the CLI handles everything
  return async (_llmCall: unknown, _tools: ToolContext): Promise<AgentOutput> => {
    const cliResult = await runClaudeCliAgent({
      task,
      systemPrompt: effectiveConfig.systemPrompt,
      model: effectiveConfig.model,
      maxTurns: effectiveConfig.maxTurns,
      maxBudgetUsd: effectiveConfig.maxBudgetUsd,
      cwd: effectiveConfig.cwd,
      permissionMode: effectiveConfig.permissionMode ?? 'bypassPermissions',
      allowedTools: effectiveConfig.allowedTools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      disallowedTools: effectiveConfig.disallowedTools,
      onTurn: effectiveConfig.onTurn,
      ttlMs: effectiveConfig.ttlMs,
      claudeBinary: effectiveConfig.claudeBinary,
      extraFlags: effectiveConfig.extraFlags,
    });

    return {
      finalMessage: cliResult.finalMessage,
      artifacts: cliResult.writtenFiles.length > 0 ? cliResult.writtenFiles : undefined,
    };
  };
}
