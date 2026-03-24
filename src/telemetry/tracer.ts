import { Langfuse, LangfuseTraceClient } from 'langfuse';
import type {
  RunConfig,
  KillReason,
  Middleware,
  LlmCallFn,
  LlmMessage,
  LlmCallOptions,
  LlmResponse,
} from '../types/index.js';

/** Middleware event passed to traceMiddlewareEvent */
export interface MiddlewareEvent {
  type: string;
  details?: Record<string, unknown>;
}

/**
 * RunTracer manages a single Langfuse root trace per run.
 * Agent code never receives a reference to this class — append-only by construction.
 */
export class RunTracer {
  private readonly langfuse: Langfuse;
  private readonly trace: LangfuseTraceClient;
  private readonly runId: string;
  private readonly startTime: Date;

  private constructor(
    langfuse: Langfuse,
    trace: LangfuseTraceClient,
    runId: string,
    startTime: Date,
  ) {
    this.langfuse = langfuse;
    this.trace = trace;
    this.runId = runId;
    this.startTime = startTime;
  }

  /**
   * Create a RunTracer with a root Langfuse trace for the given run.
   * Auth is pulled from LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST env vars.
   */
  static create(runConfig: RunConfig): RunTracer {
    const startTime = new Date();

    const langfuse = new Langfuse({
      publicKey: process.env['LANGFUSE_PUBLIC_KEY'],
      secretKey: process.env['LANGFUSE_SECRET_KEY'],
      baseUrl: process.env['LANGFUSE_BASE_URL'] ?? process.env['LANGFUSE_HOST'],
    });

    const runId = crypto.randomUUID();

    const trace = langfuse.trace({
      id: runId,
      name: `crucible-run-${runConfig.variantLabel}`,
      timestamp: startTime,
      metadata: {
        variantLabel: runConfig.variantLabel,
        tokenBudget: runConfig.tokenBudget,
        ttlSeconds: runConfig.ttlSeconds,
        taskDescription: runConfig.taskPayload.description,
      },
      tags: ['crucible', runConfig.variantLabel],
    });

    return new RunTracer(langfuse, trace, runId, startTime);
  }

  /** The run ID associated with this trace (generated at create time). */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Returns a Middleware that wraps LlmCallFn with a child generation span
   * recording tokens in/out, model, and latency.
   * The returned middleware conforms to: (next: LlmCallFn) => LlmCallFn
   */
  createTracerMiddleware(): Middleware {
    return (next: LlmCallFn): LlmCallFn => {
      return async (
        messages: LlmMessage[],
        options?: LlmCallOptions,
      ): Promise<LlmResponse> => {
        const spanStart = new Date();

        const generation = this.trace.generation({
          name: 'llm-call',
          startTime: spanStart,
          model: options?.model ?? 'unknown',
          input: messages,
          metadata: {
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
          },
        });

        const response = await next(messages, options);

        const spanEnd = new Date();
        const latencyMs = spanEnd.getTime() - spanStart.getTime();

        generation.end({
          output: response.content,
          model: response.model,
          usage: {
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            totalTokens:
              response.usage.promptTokens + response.usage.completionTokens,
          },
          metadata: {
            latencyMs,
          },
        });

        return response;
      };
    };
  }

  /**
   * Record a tool call as a child span on the root trace.
   */
  async traceToolCall(
    name: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ): Promise<void> {
    const now = new Date();
    const startTime = new Date(now.getTime() - durationMs);

    const span = this.trace.span({
      name: `tool-call:${name}`,
      startTime,
      input,
      metadata: { durationMs },
    });

    span.end({
      output,
    });
  }

  /**
   * Record a middleware event (budget warnings, loop flags) as a child span.
   */
  async traceMiddlewareEvent(event: MiddlewareEvent): Promise<void> {
    const now = new Date();

    const span = this.trace.span({
      name: `middleware-event:${event.type}`,
      startTime: now,
      input: event.details ?? {},
      metadata: { eventType: event.type },
    });

    span.end();
  }

  /**
   * Close the root trace with the kill reason and final token count,
   * then flush all pending events to Langfuse.
   * If flush fails, the error is logged but not thrown — teardown must not be blocked.
   */
  async close(killReason: KillReason, tokenCount: number): Promise<void> {
    const endTime = new Date();
    const wallTimeMs = endTime.getTime() - this.startTime.getTime();

    this.trace.update({
      output: {
        killReason,
        tokenCount,
        wallTimeMs,
      },
      metadata: {
        killReasonType: killReason.type,
        tokenCount,
        wallTimeMs,
        completedAt: endTime.toISOString(),
      },
    });

    try {
      await this.langfuse.flushAsync();
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'langfuse_flush_failed',
          runId: this.runId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}
