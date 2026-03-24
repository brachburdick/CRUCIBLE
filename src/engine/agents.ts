import type { AgentFn, TaskPayload } from '../types/index.js';
import { createAgent } from '../agents/echo.js';
import { createLoopingAgent } from '../agents/looping.js';

/** Registry of available agent factories, keyed by name. */
export const AGENTS: Record<string, (task: TaskPayload) => AgentFn> = {
  echo: createAgent,
  looping: createLoopingAgent,
};

/** Get a list of registered agent names. */
export function getAgentNames(): string[] {
  return Object.keys(AGENTS);
}
