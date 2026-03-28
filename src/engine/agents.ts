import type { AgentFn, TaskPayload } from '../types/index.js';
import { createAgent } from '../agents/echo.js';
import { createLoopingAgent } from '../agents/looping.js';
import { createCoderAgent, type CoderAgentConfig } from '../agents/coder.js';
import { createCliAgent, type CliAgentConfig } from '../agents/cli-runner.js';
import { createDockerCliAgent, type DockerCliAgentConfig } from '../agents/docker-cli-agent.js';

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
  /** Claude CLI on host — subscription auth, no isolation */
  'claude-cli': (task, config?) => createCliAgent(task, config as CliAgentConfig | undefined),
  /** Claude CLI in Docker — subscription auth, full isolation */
  'docker-cli': (task, config?) => createDockerCliAgent(task, config as DockerCliAgentConfig | undefined),
};

/** Get a list of registered agent names. */
export function getAgentNames(): string[] {
  return Object.keys(AGENTS);
}
