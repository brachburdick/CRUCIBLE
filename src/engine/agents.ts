import type { AgentFn, TaskPayload } from '../types/index.js';
import { createAgent } from '../agents/echo.js';
import { createLoopingAgent } from '../agents/looping.js';
import { createCoderAgent, type CoderAgentConfig } from '../agents/coder.js';

/**
 * Agent factory signature.
 * The optional second argument allows passing agent-specific config
 * (e.g., CoderAgentConfig for variant-driven system prompts).
 */
export type AgentFactory = (task: TaskPayload, config?: Record<string, unknown>) => AgentFn;

/** Registry of available agent factories, keyed by name. */
export const AGENTS: Record<string, AgentFactory> = {
  echo: createAgent,
  looping: createLoopingAgent,
  coder: (task, config?) => createCoderAgent(task, config as CoderAgentConfig | undefined),
};

/** Get a list of registered agent names. */
export function getAgentNames(): string[] {
  return Object.keys(AGENTS);
}
