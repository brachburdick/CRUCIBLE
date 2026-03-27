import { EventEmitter } from 'node:events';
import type {
  AgentFn,
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
import { composeMiddleware } from '../middleware/stack.js';
import { RunTracer } from '../telemetry/tracer.js';
import { baseLlmCall } from './llm.js';
import { AGENTS } from './agents.js';
import { runChecks } from './scorer.js';
import type { ScoreResult } from '../types/index.js';

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

    // Build tool context
    const toolContext = sandboxRunner.getToolContext();

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

    // Run agent
    let killReason: KillReason;
    let scoreResult: ScoreResult | undefined;

    try {
      const agentResult = await Promise.race([
        (async () => {
          const agentFn = agentFactory(config.taskPayload, agentConfig);
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

    return result;
  }
}
