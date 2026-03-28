import type {
  AgentOutput,
  OnTurnCallback,
  TaskPayload,
  ToolContext,
} from '../types/index.js';
import { DockerRunner, type DockerRunnerConfig } from '../sandbox/docker-runner.js';

/**
 * Configuration for the Docker CLI agent.
 * Passed through the agent registry as Record<string, unknown>.
 */
export interface DockerCliAgentConfig {
  systemPrompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  onTurn?: OnTurnCallback;
  ttlSeconds?: number;
  extraFlags?: string[];
  imageTag?: string;
  dockerfilePath?: string;
  memoryLimit?: string;
  cpuLimit?: number;
}

/**
 * Creates an AgentFn that runs the Claude CLI inside a Docker container.
 *
 * Provides full isolation (process, filesystem, network) while using
 * the Claude Code subscription (Max plan) for billing.
 *
 * The `llmCall` and `tools` parameters are IGNORED — the Claude CLI
 * inside the container handles its own LLM calls and tool execution.
 */
export function createDockerCliAgent(
  task: TaskPayload,
  config?: DockerCliAgentConfig,
) {
  const cfg = config ?? { systemPrompt: '' };

  return async (_llmCall: unknown, _tools: ToolContext): Promise<AgentOutput> => {
    // Generate a run ID for the container
    const runId = `docker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const runnerConfig: DockerRunnerConfig = {
      runId,
      taskPayload: task,
      ttlSeconds: cfg.ttlSeconds ?? 300,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      allowedTools: cfg.allowedTools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      disallowedTools: cfg.disallowedTools,
      extraFlags: cfg.extraFlags,
      onTurn: cfg.onTurn,
      imageTag: cfg.imageTag,
      dockerfilePath: cfg.dockerfilePath,
      memoryLimit: cfg.memoryLimit,
      cpuLimit: cfg.cpuLimit,
    };

    const runner = await DockerRunner.create(runnerConfig);

    try {
      const result = await runner.run(runnerConfig);

      return {
        finalMessage: result.finalMessage,
        artifacts: result.writtenFiles.length > 0 ? result.writtenFiles : undefined,
      };
    } finally {
      await runner.destroy();
    }
  };
}
