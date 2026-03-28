import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  AgentFn,
  AgentTurnEvent,
  KillReason,
  RunConfig,
  RunResult,
  TaskPayload,
} from '../types/index.js';
import { BudgetExceededError, LoopDetectedError } from '../types/index.js';
import { SandboxRunner } from '../sandbox/runner.js';
import { createIdempotentTeardown, type TeardownContext } from '../sandbox/teardown.js';
import { createTokenBudget } from '../middleware/tokenBudget.js';
import { createLoopDetector } from '../middleware/loopDetector.js';
import { createMutationGuard } from '../middleware/mutationGuard.js';
import { composeMiddleware } from '../middleware/stack.js';
import { RunTracer } from '../telemetry/tracer.js';
import { baseLlmCall } from './llm.js';
import { AGENTS } from './agents.js';
import { runChecks } from './scorer.js';
import { detectFlowType } from './GraphExecutor.js';
import { getFlowTemplate } from '../session/flow-templates.js';
import { createRunRecord } from '../session/run-record.js';
import { runClaudeCliAgent, type CliAgentResult } from '../agents/cli-runner.js';
import { DockerRunner } from '../sandbox/docker-runner.js';
import type { SessionModel } from '../session/index.js';
import type { ScoreResult } from '../types/index.js';
import type { FlowTemplate } from '../session/types.js';

export interface RunEvent {
  runId: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * RunEngine orchestrates agent runs and emits structured events.
 *
 * Replaces the monolithic cli/run.ts main() function with a programmatic API.
 * Both the CLI wrapper and the web server use this class to start runs.
 *
 * Events emitted (all as RunEvent objects):
 *   'run:event' — every event (single listener gets everything)
 *
 * The engine does NOT call process.exit(). Callers translate the
 * RunResult.exitReason into exit codes or HTTP responses as needed.
 */
export class RunEngine extends EventEmitter {
  private activeRuns = new Map<string, { config: RunConfig; agentName: string; startedAt: Date }>();
  private session: SessionModel | null = null;

  /**
   * Attach a SessionModel for session-aware runs.
   * When set, runs will:
   * - Enforce mutation budgets via MutationGuard
   * - Inject flow templates into the agent system prompt
   * - Write run records to .agent/runs.jsonl
   */
  setSession(session: SessionModel): void {
    this.session = session;
  }

  /** Emit a structured run event. */
  private emitRunEvent(runId: string, event: string, data: Record<string, unknown>): void {
    const runEvent: RunEvent = {
      runId,
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit('run:event', runEvent);
  }

  /** Get the list of available agent names. */
  getAgentNames(): string[] {
    return Object.keys(AGENTS);
  }

  /** Get currently active run IDs. */
  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  /**
   * Start a run. Returns the RunResult when the run completes (cleanly or killed).
   * Emits events throughout the run lifecycle.
   * Never throws — errors are captured and returned as part of the result.
   *
   * @param agentConfig Optional config passed to the agent factory (e.g., CoderAgentConfig)
   */
  async startRun(config: RunConfig, agentName: string, agentConfig?: Record<string, unknown>): Promise<RunResult> {
    // Validate agent
    const agentFactory = AGENTS[agentName];
    if (!agentFactory) {
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(AGENTS).join(', ')}`);
    }

    const startedAt = new Date();

    // Create tracer (generates runId)
    const tracer = RunTracer.create(config);
    const runId = tracer.getRunId();

    this.activeRuns.set(runId, { config, agentName, startedAt });

    this.emitRunEvent(runId, 'run_started', {
      variant: config.variantLabel,
      agent: agentName,
      budget: config.tokenBudget,
      ttlSeconds: config.ttlSeconds,
      taskDescription: config.taskPayload.description,
    });

    // ─── CLI agent path: uses Claude Code subscription, no E2B sandbox ───
    if (agentName === 'claude-cli') {
      return this.startCliRun(runId, config, agentConfig, startedAt, tracer);
    }

    // ─── Docker CLI path: subscription auth + full container isolation ───
    if (agentName === 'docker-cli') {
      return this.startDockerCliRun(runId, config, agentConfig, startedAt, tracer);
    }

    // Create sandbox
    const sandboxRunner = await SandboxRunner.create(config);
    this.emitRunEvent(runId, 'sandbox_created', {});

    // Create token budget middleware
    const { middleware: tokenBudgetMW, getTokenCount } = createTokenBudget({
      budget: config.tokenBudget,
      onWarning: (threshold, currentCount, budget) => {
        this.emitRunEvent(runId, 'token_warning', { threshold, currentCount, budget });
      },
    });

    // Create loop detector middleware
    const loopDetectorMW = createLoopDetector({
      windowSize: config.loopDetection.windowSize,
      similarityThreshold: config.loopDetection.similarityThreshold,
      consecutiveTurns: config.loopDetection.consecutiveTurns,
      onWarning: (meanSimilarity, consecutiveCount) => {
        this.emitRunEvent(runId, 'loop_warning', { meanSimilarity, consecutiveCount });
      },
    });

    // Create tracer middleware
    const tracerMW = tracer.createTracerMiddleware();

    // Compose middleware stack
    const wrappedLlmCall = composeMiddleware(baseLlmCall, tracerMW, tokenBudgetMW, loopDetectorMW);

    // Build tool context — wrap with mutation guard if session is active
    const rawToolContext = sandboxRunner.getToolContext();
    let toolContext = rawToolContext;

    if (this.session) {
      this.session.mutations.resetNode();
      toolContext = createMutationGuard(this.session.mutations, rawToolContext);
    }

    // Build teardown context with emit callback
    const teardownContext: TeardownContext = {
      sandboxRunner,
      tracer,
      getTokenCount,
      runConfig: config,
      startedAt,
      emit: (event: string, data: Record<string, unknown>) => {
        this.emitRunEvent(runId, event, data);
      },
    };

    // Create idempotent teardown
    const safeTeardown = createIdempotentTeardown(teardownContext);

    // TTL timer — resolves a promise instead of calling process.exit()
    let ttlKillReason: KillReason | null = null;
    let ttlTimer: NodeJS.Timeout | null = null;
    const ttlMs = config.ttlSeconds * 1000;

    const ttlPromise = new Promise<void>((resolve) => {
      ttlTimer = setTimeout(async () => {
        const wallTimeMs = Date.now() - startedAt.getTime();
        ttlKillReason = { type: 'ttl_exceeded', wallTimeMs, ttlMs };
        await safeTeardown(ttlKillReason);
        resolve();
      }, ttlMs);
      ttlTimer.unref();
    });

    // Detect flow type and inject flow template into agent config
    let effectiveAgentConfig = agentConfig;
    if (this.session) {
      const flowType = detectFlowType(config.taskPayload.description);
      const flow = getFlowTemplate(flowType);
      const flowPromptSection = this.buildFlowPromptSection(flow);

      // Prepend flow instructions to the system prompt
      const existingPrompt = agentConfig?.systemPrompt as string | undefined ?? '';
      effectiveAgentConfig = {
        ...agentConfig,
        systemPrompt: flowPromptSection + (existingPrompt ? '\n\n' + existingPrompt : ''),
      };

      this.emitRunEvent(runId, 'flow_detected', { flowType, phases: flow.phases.map(p => p.name) });
    }

    // Inject onTurn callback for per-turn visibility
    effectiveAgentConfig = {
      ...effectiveAgentConfig,
      onTurn: (turnEvent: AgentTurnEvent) => {
        this.emitRunEvent(runId, turnEvent.type, turnEvent as unknown as Record<string, unknown>);
      },
    };

    // Run agent
    let killReason: KillReason;
    let scoreResult: ScoreResult | undefined;

    try {
      const agentResult = await Promise.race([
        (async () => {
          const agentFn = agentFactory(config.taskPayload, effectiveAgentConfig);
          return agentFn(wrappedLlmCall, toolContext);
        })(),
        ttlPromise.then(() => null), // TTL fires → returns null
      ]);

      if (agentResult === null || ttlKillReason) {
        // TTL killed the run
        killReason = ttlKillReason!;
      } else {
        // Clean completion
        this.emitRunEvent(runId, 'agent_completed', { finalMessage: agentResult.finalMessage });
        killReason = { type: 'completed' };
        if (ttlTimer) clearTimeout(ttlTimer);

        // Run acceptance checks before teardown (sandbox still alive)
        if (config.taskPayload.checks && config.taskPayload.checks.length > 0) {
          try {
            scoreResult = await runChecks(config.taskPayload.checks, toolContext);
            this.emitRunEvent(runId, 'checks_completed', {
              passRate: scoreResult.passRate,
              checks: scoreResult.checks.map((c) => ({ name: c.name, passed: c.passed })),
            });
          } catch (err) {
            this.emitRunEvent(runId, 'checks_error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        await safeTeardown(killReason);
      }
    } catch (err) {
      if (ttlTimer) clearTimeout(ttlTimer);

      if (err instanceof BudgetExceededError) {
        killReason = {
          type: 'budget_exceeded',
          tokenCount: err.tokenCount,
          budget: err.budget,
        };
      } else if (err instanceof LoopDetectedError) {
        killReason = {
          type: 'loop_detected',
          similarityScore: err.similarityScore,
          consecutiveCount: err.consecutiveCount,
          lastMessages: err.lastMessages,
        };
      } else {
        this.emitRunEvent(runId, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
        killReason = { type: 'completed' };
      }
      await safeTeardown(killReason);
    }

    this.activeRuns.delete(runId);

    // Build RunResult (matches what teardown writes to result.json)
    const completedAt = new Date();
    const result: RunResult = {
      runId,
      variantLabel: config.variantLabel,
      exitReason: killReason,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: getTokenCount(),
      },
      wallTimeMs: completedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      artifacts: { outputDir: `runs/${runId}/artifacts`, files: [] },
      metadata: scoreResult ? { scores: scoreResult } : undefined,
    };

    this.emitRunEvent(runId, 'run_completed', {
      exitReason: killReason,
      tokenCount: getTokenCount(),
      wallTimeMs: result.wallTimeMs,
      scores: scoreResult ? { passRate: scoreResult.passRate } : undefined,
    });

    // Write run record to .agent/runs.jsonl if session is active
    if (this.session) {
      const runResult = killReason.type === 'completed'
        ? (scoreResult && scoreResult.passRate < 1.0 ? 'partial' : 'success')
        : 'failed';

      const record = createRunRecord({
        projectId: 'crucible',
        taskId: config.variantLabel,
        taskType: 'feature',
        result: runResult as 'success' | 'partial' | 'failed',
        summary: `Run ${runId}: ${killReason.type}, ${getTokenCount()} tokens, ${result.wallTimeMs}ms`,
        filesTouched: this.session.mutations.getState().uniqueFiles,
      });

      try {
        await this.session.runRecords.append(record);
        this.emitRunEvent(runId, 'run_record_written', { recordId: record.runId });
      } catch (err) {
        this.emitRunEvent(runId, 'run_record_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Docker-isolated CLI run: Claude CLI inside a Docker container.
   *
   * Full isolation (process, filesystem, network) with subscription auth.
   * The DockerRunner handles container lifecycle, file seeding, and cleanup.
   * Stream-json parsing is identical to the bare CLI path.
   */
  private async startDockerCliRun(
    runId: string,
    config: RunConfig,
    agentConfig: Record<string, unknown> | undefined,
    startedAt: Date,
    tracer: RunTracer,
  ): Promise<RunResult> {
    // Build system prompt with flow template
    let systemPrompt = (agentConfig?.systemPrompt as string) ?? '';
    if (this.session) {
      const flowType = detectFlowType(config.taskPayload.description);
      const flow = getFlowTemplate(flowType);
      const flowPromptSection = this.buildFlowPromptSection(flow);
      systemPrompt = flowPromptSection + (systemPrompt ? '\n\n' + systemPrompt : '');
      this.emitRunEvent(runId, 'flow_detected', { flowType, phases: flow.phases.map(p => p.name) });
    }

    let runner: DockerRunner | null = null;

    try {
      // Create Docker container, seed files
      runner = await DockerRunner.create({
        runId,
        taskPayload: config.taskPayload,
        ttlSeconds: config.ttlSeconds,
        systemPrompt,
        model: agentConfig?.model as string | undefined,
        maxTurns: (agentConfig?.maxTurns as number | undefined) ?? 50,
        maxBudgetUsd: agentConfig?.maxBudgetUsd as number | undefined,
        allowedTools: (agentConfig?.allowedTools as string[] | undefined) ?? [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        ],
        disallowedTools: agentConfig?.disallowedTools as string[] | undefined,
        extraFlags: agentConfig?.extraFlags as string[] | undefined,
        imageTag: agentConfig?.imageTag as string | undefined,
        dockerfilePath: agentConfig?.dockerfilePath as string | undefined,
        memoryLimit: agentConfig?.memoryLimit as string | undefined,
        cpuLimit: agentConfig?.cpuLimit as number | undefined,
        onTurn: (turnEvent: AgentTurnEvent) => {
          this.emitRunEvent(runId, turnEvent.type, turnEvent as unknown as Record<string, unknown>);
        },
      });

      this.emitRunEvent(runId, 'docker_container_created', { runId });

      // Run the agent inside the container
      const cliResult = await runner.run({
        runId,
        taskPayload: config.taskPayload,
        ttlSeconds: config.ttlSeconds,
        systemPrompt,
        model: agentConfig?.model as string | undefined,
        maxTurns: (agentConfig?.maxTurns as number | undefined) ?? 50,
        maxBudgetUsd: agentConfig?.maxBudgetUsd as number | undefined,
        allowedTools: (agentConfig?.allowedTools as string[] | undefined) ?? [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        ],
        disallowedTools: agentConfig?.disallowedTools as string[] | undefined,
        extraFlags: agentConfig?.extraFlags as string[] | undefined,
        onTurn: (turnEvent: AgentTurnEvent) => {
          this.emitRunEvent(runId, turnEvent.type, turnEvent as unknown as Record<string, unknown>);
        },
      });

      // Map CLI result to KillReason
      let killReason: KillReason;
      switch (cliResult.killReason) {
        case 'completed':
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'agent_completed', { finalMessage: cliResult.finalMessage });
          break;
        case 'ttl_exceeded':
          killReason = {
            type: 'ttl_exceeded',
            wallTimeMs: cliResult.durationMs,
            ttlMs: config.ttlSeconds * 1000,
          };
          break;
        case 'stopped':
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'agent_completed', {
            finalMessage: `Turn limit reached. ${cliResult.finalMessage}`,
          });
          break;
        case 'rate_limited':
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'rate_limited', {
            message: 'Claude Code subscription rate limit hit',
          });
          break;
        default:
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'error', {
            error: cliResult.stderr || cliResult.finalMessage || 'Docker CLI agent error',
          });
          break;
      }

      // Run acceptance checks inside the container (before teardown)
      let scoreResult: ScoreResult | undefined;
      if (config.taskPayload.checks && config.taskPayload.checks.length > 0 && killReason.type === 'completed') {
        try {
          scoreResult = await runner.runChecks(config.taskPayload.checks);
          this.emitRunEvent(runId, 'checks_completed', {
            passRate: scoreResult.passRate,
            checks: scoreResult.checks.map(c => ({ name: c.name, passed: c.passed })),
          });
        } catch (err) {
          this.emitRunEvent(runId, 'checks_error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Flush artifacts from container to host
      const artifactManifest = await runner.flushArtifacts(runId);

      // Cleanup
      this.activeRuns.delete(runId);
      const completedAt = new Date();
      const totalTokens = cliResult.usage.inputTokens + cliResult.usage.outputTokens;

      const result: RunResult = {
        runId,
        variantLabel: config.variantLabel,
        exitReason: killReason,
        tokenUsage: {
          promptTokens: cliResult.usage.inputTokens,
          completionTokens: cliResult.usage.outputTokens,
          totalTokens,
        },
        wallTimeMs: completedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        artifacts: artifactManifest,
        metadata: {
          ...(scoreResult ? { scores: scoreResult } : {}),
          cliSessionId: cliResult.sessionId,
          totalCostUsd: cliResult.totalCostUsd,
          numTurns: cliResult.numTurns,
          executionMode: 'docker-cli',
        },
      };

      this.emitRunEvent(runId, 'run_completed', {
        exitReason: killReason,
        tokenCount: totalTokens,
        wallTimeMs: result.wallTimeMs,
        totalCostUsd: cliResult.totalCostUsd,
        scores: scoreResult ? { passRate: scoreResult.passRate } : undefined,
      });

      // Write run record
      if (this.session) {
        const runResult = killReason.type === 'completed'
          ? (scoreResult && scoreResult.passRate < 1.0 ? 'partial' : 'success')
          : 'failed';

        const record = createRunRecord({
          projectId: 'crucible',
          taskId: config.variantLabel,
          taskType: 'feature',
          result: runResult as 'success' | 'partial' | 'failed',
          summary: `Docker CLI run ${runId}: ${killReason.type}, ${totalTokens} tokens, $${cliResult.totalCostUsd.toFixed(4)}, ${result.wallTimeMs}ms`,
          filesTouched: cliResult.writtenFiles,
        });

        try {
          await this.session.runRecords.append(record);
        } catch {
          // Non-fatal
        }
      }

      await tracer.close(killReason, totalTokens);
      await runner.destroy();

      return result;

    } catch (err) {
      this.activeRuns.delete(runId);
      this.emitRunEvent(runId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });

      if (runner) {
        await runner.destroy();
      }

      const completedAt = new Date();
      const killReason: KillReason = { type: 'completed' };
      const result: RunResult = {
        runId,
        variantLabel: config.variantLabel,
        exitReason: killReason,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        wallTimeMs: completedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        artifacts: { outputDir: '', files: [] },
        metadata: { error: err instanceof Error ? err.message : String(err) },
      };

      this.emitRunEvent(runId, 'run_completed', {
        exitReason: killReason,
        tokenCount: 0,
        wallTimeMs: result.wallTimeMs,
        error: err instanceof Error ? err.message : String(err),
      });

      return result;
    }
  }

  /**
   * CLI-based run: spawns `claude -p` with subscription auth.
   *
   * Instead of E2B sandbox + Anthropic API, this:
   *   1. Creates a temp directory and seeds it with task files
   *   2. Spawns `claude -p --output-format stream-json` pointed at that dir
   *   3. Parses the stream-json events and maps them to CRUCIBLE RunEvents
   *   4. Collects artifacts from the temp dir after completion
   *
   * No ANTHROPIC_API_KEY needed — uses Claude Code subscription (Max plan).
   */
  private async startCliRun(
    runId: string,
    config: RunConfig,
    agentConfig: Record<string, unknown> | undefined,
    startedAt: Date,
    tracer: RunTracer,
  ): Promise<RunResult> {
    // Create a temp working directory and seed it with task files
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `crucible-${runId}-`));
    this.emitRunEvent(runId, 'cli_workdir_created', { workDir });

    try {
      // Seed files from task payload
      if (config.taskPayload.files) {
        for (const [filePath, content] of Object.entries(config.taskPayload.files)) {
          const fullPath = path.join(workDir, filePath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, 'utf-8');
        }
      }

      // Seed directory (copy tree)
      if (config.taskPayload.seedDir) {
        await this.copySeedDir(config.taskPayload.seedDir, workDir);
      }

      // Build system prompt with flow template
      let systemPrompt = (agentConfig?.systemPrompt as string) ?? '';
      if (this.session) {
        const flowType = detectFlowType(config.taskPayload.description);
        const flow = getFlowTemplate(flowType);
        const flowPromptSection = this.buildFlowPromptSection(flow);
        systemPrompt = flowPromptSection + (systemPrompt ? '\n\n' + systemPrompt : '');
        this.emitRunEvent(runId, 'flow_detected', { flowType, phases: flow.phases.map(p => p.name) });
      }

      // Run the CLI agent
      const cliResult = await runClaudeCliAgent({
        task: config.taskPayload,
        systemPrompt,
        model: agentConfig?.model as string | undefined,
        maxTurns: (agentConfig?.maxTurns as number | undefined) ?? 50,
        maxBudgetUsd: agentConfig?.maxBudgetUsd as number | undefined,
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        allowedTools: (agentConfig?.allowedTools as string[] | undefined) ?? [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        ],
        disallowedTools: agentConfig?.disallowedTools as string[] | undefined,
        ttlMs: config.ttlSeconds * 1000,
        claudeBinary: agentConfig?.claudeBinary as string | undefined,
        extraFlags: agentConfig?.extraFlags as string[] | undefined,
        onTurn: (turnEvent: AgentTurnEvent) => {
          this.emitRunEvent(runId, turnEvent.type, turnEvent as unknown as Record<string, unknown>);
        },
      });

      // Map CLI result to CRUCIBLE KillReason
      let killReason: KillReason;
      switch (cliResult.killReason) {
        case 'completed':
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'agent_completed', { finalMessage: cliResult.finalMessage });
          break;
        case 'ttl_exceeded':
          killReason = {
            type: 'ttl_exceeded',
            wallTimeMs: cliResult.durationMs,
            ttlMs: config.ttlSeconds * 1000,
          };
          break;
        case 'stopped':
          // maxTurns exceeded — map to completed with note
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'agent_completed', {
            finalMessage: `Turn limit reached. ${cliResult.finalMessage}`,
          });
          break;
        case 'rate_limited':
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'rate_limited', {
            message: 'Claude Code subscription rate limit hit',
          });
          break;
        case 'error':
        default:
          killReason = { type: 'completed' };
          this.emitRunEvent(runId, 'error', {
            error: cliResult.stderr || cliResult.finalMessage || 'CLI agent error',
          });
          break;
      }

      // Run acceptance checks against the workdir (no sandbox — run on host)
      let scoreResult: ScoreResult | undefined;
      if (config.taskPayload.checks && config.taskPayload.checks.length > 0 && killReason.type === 'completed') {
        try {
          const { execSync } = await import('node:child_process');
          const checks = config.taskPayload.checks.map(check => {
            try {
              const result = execSync(check.command, {
                cwd: workDir,
                timeout: (check.timeout ?? 30) * 1000,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              return {
                name: check.name,
                passed: true,
                stdout: result,
                exitCode: 0,
              };
            } catch (err: unknown) {
              const execErr = err as { status?: number; stdout?: string; stderr?: string };
              return {
                name: check.name,
                passed: (execErr.status ?? 1) === (check.expectedExitCode ?? 0),
                stdout: execErr.stdout ?? '',
                stderr: execErr.stderr ?? '',
                exitCode: execErr.status ?? 1,
              };
            }
          });
          const passRate = checks.filter(c => c.passed).length / checks.length;
          scoreResult = { checks, passRate };
          this.emitRunEvent(runId, 'checks_completed', {
            passRate,
            checks: checks.map(c => ({ name: c.name, passed: c.passed })),
          });
        } catch (err) {
          this.emitRunEvent(runId, 'checks_error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Flush artifacts — copy workdir files to runs/<runId>/artifacts/
      const artifactDir = path.join('runs', runId, 'artifacts');
      await fs.mkdir(artifactDir, { recursive: true });
      await this.copyDir(workDir, artifactDir);

      this.activeRuns.delete(runId);

      const completedAt = new Date();
      const totalTokens = cliResult.usage.inputTokens + cliResult.usage.outputTokens;

      const result: RunResult = {
        runId,
        variantLabel: config.variantLabel,
        exitReason: killReason,
        tokenUsage: {
          promptTokens: cliResult.usage.inputTokens,
          completionTokens: cliResult.usage.outputTokens,
          totalTokens,
        },
        wallTimeMs: completedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        artifacts: { outputDir: artifactDir, files: [] },
        metadata: {
          ...(scoreResult ? { scores: scoreResult } : {}),
          cliSessionId: cliResult.sessionId,
          totalCostUsd: cliResult.totalCostUsd,
          numTurns: cliResult.numTurns,
        },
      };

      this.emitRunEvent(runId, 'run_completed', {
        exitReason: killReason,
        tokenCount: totalTokens,
        wallTimeMs: result.wallTimeMs,
        totalCostUsd: cliResult.totalCostUsd,
        scores: scoreResult ? { passRate: scoreResult.passRate } : undefined,
      });

      // Write run record
      if (this.session) {
        const runResult = killReason.type === 'completed'
          ? (scoreResult && scoreResult.passRate < 1.0 ? 'partial' : 'success')
          : 'failed';

        const record = createRunRecord({
          projectId: 'crucible',
          taskId: config.variantLabel,
          taskType: 'feature',
          result: runResult as 'success' | 'partial' | 'failed',
          summary: `CLI run ${runId}: ${killReason.type}, ${totalTokens} tokens, $${cliResult.totalCostUsd.toFixed(4)}, ${result.wallTimeMs}ms`,
          filesTouched: cliResult.writtenFiles,
        });

        try {
          await this.session.runRecords.append(record);
        } catch {
          // Non-fatal
        }
      }

      // Cleanup temp dir
      await tracer.close(killReason, totalTokens);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

      return result;

    } catch (err) {
      this.activeRuns.delete(runId);
      this.emitRunEvent(runId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

      const completedAt = new Date();
      const killReason: KillReason = { type: 'completed' };
      const result: RunResult = {
        runId,
        variantLabel: config.variantLabel,
        exitReason: killReason,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        wallTimeMs: completedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        artifacts: { outputDir: '', files: [] },
        metadata: { error: err instanceof Error ? err.message : String(err) },
      };

      this.emitRunEvent(runId, 'run_completed', {
        exitReason: killReason,
        tokenCount: 0,
        wallTimeMs: result.wallTimeMs,
        error: err instanceof Error ? err.message : String(err),
      });

      return result;
    }
  }

  /** Copy a local directory tree to a destination, skipping heavy dirs. */
  private async copySeedDir(srcDir: string, destDir: string): Promise<void> {
    const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'venv', '.cache']);
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await this.copySeedDir(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /** Copy all files from src to dest. */
  private async copyDir(srcDir: string, destDir: string): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await this.copyDir(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /** Build a system prompt section from a flow template. */
  private buildFlowPromptSection(flow: FlowTemplate): string {
    const phases = flow.phases
      .map((p, i) => `${i + 1}. **${p.name}**: ${p.description}`)
      .join('\n');

    const rules = flow.rules
      .filter(r => r.enforcement === 'hard')
      .map(r => `- ${r.description}`)
      .join('\n');

    return [
      `## Flow: ${flow.type}`,
      `${flow.description}`,
      '',
      '### Phases (follow in order):',
      phases,
      '',
      '### Hard Rules:',
      rules,
      '',
      '### Constraints:',
      '- 2 consecutive file mutations without running tests = blocked',
      '- After 2 failed attempts at the same fix, escalate',
      '- If context feels degraded (turn > 40), wrap up with partial result',
    ].join('\n');
  }
}
